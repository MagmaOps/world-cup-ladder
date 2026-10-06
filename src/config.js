// Centralised configuration, driven entirely by environment variables so the
// same image can be configured per deployment (see k8s ConfigMap).

const DEFAULT_SOURCE_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTLWEqvGmL5UhP1wKBpMyus9nNlNh_OehPrwkmcyTWBNLS_d4QinlPKLVdZNdrZj_DtNqyit_quFUfh/pub?gid=1410145111&single=true&output=csv';

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  // CSV export of the published Google Sheet. The PDR provides a pubhtml URL,
  // but that page renders its table via JavaScript and contains no parseable
  // markup. The published-sheet CSV endpoint returns the same data as clean,
  // structured rows, so we use it instead.
  sourceUrl: process.env.SOURCE_URL || DEFAULT_SOURCE_URL,
  syncIntervalMinutes: intFromEnv('SYNC_INTERVAL_MINUTES', 60),
  databasePath: process.env.DATABASE_PATH || '/data/world-cup-ladder.db',
  port: intFromEnv('PORT', 8080),
};
