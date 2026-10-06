import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { getPlayers, getLastSuccessfulSync, getHistory } from './db.js';
import { runSync } from './sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// ── Static frontend ─────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, '..', 'public')));

// ── API routes ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/players', (_req, res) => {
  const players = getPlayers();
  const lastSuccessfulSync = getLastSuccessfulSync();
  res.json({ players, lastSuccessfulSync });
});

app.get('/api/history', (_req, res) => {
  const { timestamps, series } = getHistory();
  res.json({ timestamps, series, lastSuccessfulSync: getLastSuccessfulSync() });
});

app.post('/api/sync', async (_req, res) => {
  const result = await runSync({ trigger: 'manual' });
  if (result.skipped) {
    return res.status(409).json(result);
  }
  res.status(result.ok ? 200 : 502).json(result);
});

// ── Scheduler ───────────────────────────────────────────────────────────────

const intervalMs = config.syncIntervalMinutes * 60 * 1000;
setInterval(() => {
  runSync({ trigger: 'scheduled' }).catch((err) =>
    console.error('[scheduler] unhandled:', err)
  );
}, intervalMs);

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`World Cup Ladder listening on :${config.port}`);
  console.log(`Sync interval: every ${config.syncIntervalMinutes} min`);
  console.log(`Database: ${config.databasePath}`);

  // Run an initial sync on startup so the first load is never empty.
  runSync({ trigger: 'startup' }).catch((err) =>
    console.error('[startup-sync] failed:', err)
  );
});
