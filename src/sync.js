import { config } from './config.js';
import { parseCsv } from './csv.js';
import { replaceAllPlayers, getLastSuccessfulSync } from './db.js';

// Source headers -> internal fields. Matched case-insensitively and trimmed so
// minor spreadsheet edits (capitalisation, stray spaces) don't break parsing.
// Both the original Portuguese display headers and the newer English CSV keys
// are accepted, so a header rename on either side keeps syncing.
const HEADER_MAP = {
  // name
  jogadores: 'name',
  user_name: 'name',
  // category
  categoria: 'category',
  category: 'category',
  // points
  pontos: 'points',
  total_points: 'points',
};

// Single in-process lock. replicas is fixed at 1 (see PDR), so an in-memory
// guard is sufficient to prevent the hourly timer and a manual POST /api/sync
// from running concurrently.
let syncing = false;

function findColumnIndexes(headerRow) {
  const indexes = {};
  headerRow.forEach((raw, i) => {
    const key = String(raw).trim().toLowerCase();
    if (HEADER_MAP[key]) indexes[HEADER_MAP[key]] = i;
  });
  return indexes;
}

function parsePoints(raw) {
  if (raw === undefined || raw === null) return NaN;
  // Strip thousands separators / spaces; accept comma or dot free integers.
  const cleaned = String(raw).replace(/[^\d.-]/g, '');
  if (cleaned === '') return NaN;
  return Number.parseInt(cleaned, 10);
}

// Turn raw CSV rows into validated, ranked player records.
export function buildPlayers(rows) {
  if (!rows || rows.length === 0) {
    throw new Error('Source returned no rows');
  }

  // The sheet has a leading blank spacer row before the real header, so scan
  // for the first row that actually contains our expected headers.
  let headerIdx = -1;
  let cols = null;
  for (let i = 0; i < rows.length; i++) {
    const candidate = findColumnIndexes(rows[i]);
    if (candidate.name !== undefined && candidate.points !== undefined) {
      headerIdx = i;
      cols = candidate;
      break;
    }
  }

  if (headerIdx === -1) {
    throw new Error(
      'Could not locate required columns (Jogadores, Categoria, Pontos) in source'
    );
  }

  const players = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = (row[cols.name] ?? '').trim();
    const category =
      cols.category !== undefined ? (row[cols.category] ?? '').trim() : '';
    const points = parsePoints(row[cols.points]);

    // Skip padding/empty rows: a real player must have a name and valid points.
    if (name === '' || Number.isNaN(points)) continue;

    players.push({ name, category, points });
  }

  // Guardrail: never treat an unexpectedly empty dataset as a success.
  if (players.length === 0) {
    throw new Error('Parsed dataset is empty; refusing to overwrite data');
  }

  // Ranking: Points DESC, then Name ASC. Highest points = rank 1.
  players.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return a.name.localeCompare(b.name);
  });

  return players.map((p, i) => ({
    rank: i + 1,
    name: p.name,
    category: p.category,
    points: p.points,
  }));
}

async function fetchSource() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(config.sourceUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'world-cup-ladder/1.0' },
    });
    if (!res.ok) {
      throw new Error(`Source responded with HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

// Full sync pipeline: fetch -> parse -> validate -> persist.
// Shared by both the scheduler and the manual endpoint. On any failure the
// existing database is left completely untouched (we only call
// replaceAllPlayers after a fully validated dataset is in hand).
export async function runSync({ trigger = 'manual' } = {}) {
  if (syncing) {
    return {
      ok: false,
      skipped: true,
      error: 'A sync is already in progress',
      lastSuccessfulSync: getLastSuccessfulSync(),
    };
  }

  syncing = true;
  const startedAt = new Date();
  console.log(`[sync] start (trigger=${trigger}) at ${startedAt.toISOString()}`);

  try {
    const csvText = await fetchSource();
    const rows = parseCsv(csvText);
    const players = buildPlayers(rows);

    const syncedAtIso = new Date().toISOString();
    replaceAllPlayers(players, syncedAtIso);

    console.log(`[sync] success: ${players.length} players at ${syncedAtIso}`);
    return {
      ok: true,
      count: players.length,
      lastSuccessfulSync: syncedAtIso,
    };
  } catch (err) {
    // Failure path: previous valid data is preserved.
    console.error(`[sync] failed: ${err.message}`);
    return {
      ok: false,
      error: err.message,
      lastSuccessfulSync: getLastSuccessfulSync(),
    };
  } finally {
    syncing = false;
  }
}

export function isSyncing() {
  return syncing;
}
