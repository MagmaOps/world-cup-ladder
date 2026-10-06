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
    rank     INTEGER NOT NULL,
    name     TEXT    NOT NULL,
    category TEXT    NOT NULL,
    points   INTEGER NOT NULL
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
`);

const selectPlayers = db.prepare(
  'SELECT rank, name, category, points FROM players ORDER BY rank ASC'
);
const deletePlayers = db.prepare('DELETE FROM players');
const insertPlayer = db.prepare(
  'INSERT INTO players (rank, name, category, points) VALUES (@rank, @name, @category, @points)'
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

export default db;
