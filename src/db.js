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

// Atomically replace the entire player set and record a successful sync time.
// Wrapped in a transaction so a crash mid-write can never leave partial data:
// either the full new dataset lands or nothing changes.
const replaceAllTxn = db.transaction((players, syncedAtIso) => {
  deletePlayers.run();
  for (const p of players) insertPlayer.run(p);
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

export default db;
