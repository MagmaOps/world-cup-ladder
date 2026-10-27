import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

// Ensure the directory for the SQLite file exists (the PVC mount, e.g. /data).
mkdirSync(dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    rank          INTEGER NOT NULL,
    name          TEXT    NOT NULL,
    category      TEXT    NOT NULL,
    points        INTEGER NOT NULL,
    registered_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- One row per player per successful sync: the raw material for the
  -- score-over-time chart. synced_at is the ISO timestamp shared by every
  -- row written in the same sync.
  CREATE TABLE IF NOT EXISTS player_history (
    synced_at TEXT    NOT NULL,
    name      TEXT    NOT NULL,
    points    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_player_history_synced_at
    ON player_history (synced_at);

  -- Composite index so per-player lookups (24h-delta baselines, daily gains)
  -- can seek by name then range-scan by time instead of scanning the table.
  CREATE INDEX IF NOT EXISTS idx_player_history_name_synced_at
    ON player_history (name, synced_at);
`);

// Migration for databases created before `registered_at` existed: add the
// column if missing. SQLite has no "ADD COLUMN IF NOT EXISTS", so check first.
{
  const cols = db.prepare('PRAGMA table_info(players)').all();
  if (!cols.some((c) => c.name === 'registered_at')) {
    db.exec('ALTER TABLE players ADD COLUMN registered_at TEXT');
  }
}

const selectPlayers = db.prepare(
  'SELECT rank, name, category, points, registered_at AS registeredAt FROM players ORDER BY rank ASC'
);
const deletePlayers = db.prepare('DELETE FROM players');
const insertPlayer = db.prepare(
  'INSERT INTO players (rank, name, category, points, registered_at) VALUES (@rank, @name, @category, @points, @registeredAt)'
);
const upsertMeta = db.prepare(
  `INSERT INTO sync_meta (key, value) VALUES (@key, @value)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);
const selectMeta = db.prepare('SELECT value FROM sync_meta WHERE key = ?');

const insertHistory = db.prepare(
  'INSERT INTO player_history (synced_at, name, points) VALUES (@synced_at, @name, @points)'
);
const selectHistory = db.prepare(
  'SELECT synced_at, name, points FROM player_history ORDER BY synced_at ASC'
);

// Baseline points per player for the 24h delta: the most recent snapshot at or
// before the cutoff. If a player has no snapshot that old (history younger than
// 24h), fall back to their earliest snapshot so we still show movement since
// tracking began.
// Set-based baselines: one grouped pass to find the target timestamp per
// player, joined back for its points. With idx_player_history_name_synced_at
// this is fast even on a large history table (vs. the old per-row correlated
// subqueries which scanned the whole table for every row).
const selectBaselineAtOrBefore = db.prepare(`
  SELECT ph.name AS name, ph.points AS points
  FROM player_history ph
  JOIN (
    SELECT name, MAX(synced_at) AS synced_at
    FROM player_history
    WHERE synced_at <= @cutoff
    GROUP BY name
  ) m ON m.name = ph.name AND m.synced_at = ph.synced_at
`);
const selectEarliest = db.prepare(`
  SELECT ph.name AS name, ph.points AS points
  FROM player_history ph
  JOIN (
    SELECT name, MIN(synced_at) AS synced_at
    FROM player_history
    GROUP BY name
  ) m ON m.name = ph.name AND m.synced_at = ph.synced_at
`);

// Atomically replace the entire player set, append a history snapshot, and
// record the successful sync time. Wrapped in a transaction so a crash
// mid-write can never leave partial data: either everything lands or nothing.
const replaceAllTxn = db.transaction((players, syncedAtIso) => {
  deletePlayers.run();
  for (const p of players) insertPlayer.run(p);
  for (const p of players) {
    insertHistory.run({ synced_at: syncedAtIso, name: p.name, points: p.points });
  }
  upsertMeta.run({ key: 'lastSuccessfulSync', value: syncedAtIso });
});

export function getPlayers() {
  return selectPlayers.all();
}

// Players plus a `delta24h` field: points gained (or lost) versus ~24h ago.
// null when there is no baseline to compare against.
export function getPlayersWithDelta(nowMs = Date.now()) {
  const players = selectPlayers.all();

  const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const baseline = new Map();
  // Earliest first so the at-or-before cutoff values overwrite them as the
  // preferred baseline where available.
  for (const r of selectEarliest.all()) baseline.set(r.name, r.points);
  for (const r of selectBaselineAtOrBefore.all({ cutoff })) baseline.set(r.name, r.points);

  return players.map((p) => {
    const base = baseline.get(p.name);
    const delta24h = base === undefined ? null : p.points - base;
    return { ...p, delta24h };
  });
}

export function getLastSuccessfulSync() {
  const row = selectMeta.get('lastSuccessfulSync');
  return row ? row.value : null;
}

export function replaceAllPlayers(players, syncedAtIso) {
  replaceAllTxn(players, syncedAtIso);
}

// Shape the flat history rows into a chart-friendly structure:
//   timestamps: sorted unique sync times
//   series:     [{ name, points: [{ t, points }] }]  (one entry per player)
// Players are ordered by their most recent points (desc) so a top-N toggle on
// the frontend can simply slice this list.
export function getHistory() {
  const rows = selectHistory.all();

  const timestampSet = new Set();
  const byPlayer = new Map();
  const latestPoints = new Map();

  for (const r of rows) {
    timestampSet.add(r.synced_at);
    if (!byPlayer.has(r.name)) byPlayer.set(r.name, []);
    byPlayer.get(r.name).push({ t: r.synced_at, points: r.points });
    latestPoints.set(r.name, r.points); // rows are time-ascending, so this ends as latest
  }

  const timestamps = [...timestampSet].sort();

  const series = [...byPlayer.entries()]
    .map(([name, points]) => ({ name, points }))
    .sort(
      (a, b) => (latestPoints.get(b.name) ?? 0) - (latestPoints.get(a.name) ?? 0)
    );

  return { timestamps, series };
}

// Top point-gainers per calendar day (UTC). For each player we take their last
// recorded points on each day, and the day's gain is that value minus their
// last value on the most recent earlier day they had data. Only positive gains
// are kept, top 3 per day, and days with no gains are omitted. Returns:
//   [{ date: 'YYYY-MM-DD', gains: [{ name, gain }] }]  (chronological)
export function getDailyGains(topPerDay = 3, maxDays = 30) {
  const rows = selectHistory.all(); // time-ascending

  // byPlayer: name -> Map(dateStr -> lastPointsThatDay)
  const byPlayer = new Map();
  const allDates = new Set();

  for (const r of rows) {
    const date = r.synced_at.slice(0, 10); // ISO date portion (UTC)
    allDates.add(date);
    if (!byPlayer.has(r.name)) byPlayer.set(r.name, new Map());
    // Rows are ascending, so the last write for a (player, date) is that day's
    // closing value.
    byPlayer.get(r.name).set(date, r.points);
  }

  const dates = [...allDates].sort();

  const result = [];
  for (const date of dates) {
    const gains = [];

    for (const [name, dayMap] of byPlayer) {
      if (!dayMap.has(date)) continue;
      const todayPoints = dayMap.get(date);

      // Find this player's closing value on their most recent earlier day.
      let prevPoints = null;
      for (const d of dates) {
        if (d >= date) break;
        if (dayMap.has(d)) prevPoints = dayMap.get(d);
      }

      // No prior day: can't attribute a gain to this day, skip.
      if (prevPoints === null) continue;

      const gain = todayPoints - prevPoints;
      if (gain > 0) gains.push({ name, gain });
    }

    gains.sort((a, b) => b.gain - a.gain || a.name.localeCompare(b.name));
    const top = gains.slice(0, topPerDay);
    if (top.length > 0) result.push({ date, gains: top });
  }

  // Keep only the most recent `maxDays` day-groups so the chart stays readable.
  return maxDays > 0 ? result.slice(-maxDays) : result;
}

export default db;
