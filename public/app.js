// World Cup Ladder — frontend logic.
// States: loading, data available, syncing, sync failed, no data.

const els = {
  syncBtn: document.getElementById('sync-btn'),
  lastUpdated: document.getElementById('last-updated'),
  status: document.getElementById('status'),
  loading: document.getElementById('state-loading'),
  empty: document.getElementById('state-empty'),
  data: document.getElementById('state-data'),
  graph: document.getElementById('graph'),
  body: document.getElementById('ladder-body'),
};

function showState(name) {
  els.loading.hidden = name !== 'loading';
  els.empty.hidden = name !== 'empty';
  els.data.hidden = name !== 'data';
}

function setStatus(message, kind) {
  if (!message) {
    els.status.hidden = true;
    els.status.textContent = '';
    els.status.className = 'status';
    return;
  }
  els.status.hidden = false;
  els.status.textContent = message;
  els.status.className = `status ${kind || 'info'}`;
}

function formatSyncTime(iso) {
  if (!iso) return 'Last updated: never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Last updated: —';
  // e.g. "06 Oct 2026 09:00"
  const date = d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Last updated: ${date} ${time}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderGraph(players) {
  els.graph.replaceChildren();
  const maxPoints = Math.max(1, ...players.map((p) => p.points));
  // Cap the graph to a readable number of leaders.
  const top = players.slice(0, 15);
  for (const p of top) {
    const row = el('div', 'bar-row');
    row.append(
      el('span', 'bar-rank', `#${p.rank}`),
      el('span', 'bar-name', p.name)
    );

    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${(p.points / maxPoints) * 100}%`;
    track.append(fill);
    row.append(track, el('span', 'bar-points', p.points.toLocaleString('en-GB')));

    els.graph.append(row);
  }
}

function renderTable(players) {
  els.body.replaceChildren();
  for (const p of players) {
    const tr = el('tr');
    tr.append(el('td', 'col-rank', String(p.rank)));
    tr.append(el('td', 'col-name', p.name));

    const catTd = el('td', 'col-category');
    if (p.category) catTd.append(el('span', 'category-pill', p.category));
    tr.append(catTd);

    tr.append(el('td', 'col-points', p.points.toLocaleString('en-GB')));
    els.body.append(tr);
  }
}

function render(data) {
  els.lastUpdated.textContent = formatSyncTime(data.lastSuccessfulSync);
  if (!data.players || data.players.length === 0) {
    showState('empty');
    return;
  }
  renderGraph(data.players);
  renderTable(data.players);
  showState('data');
}

async function loadPlayers() {
  const res = await fetch('/api/players');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function init() {
  showState('loading');
  try {
    const data = await loadPlayers();
    render(data);
  } catch (err) {
    setStatus(`Could not load data: ${err.message}`, 'error');
    showState('empty');
  }
}

async function manualSync() {
  els.syncBtn.disabled = true;
  setStatus('Syncing…', 'info');
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const result = await res.json().catch(() => ({}));

    if (res.ok && result.ok) {
      setStatus('');
      // Refresh the graph/table with the newly synced data.
      const data = await loadPlayers();
      render(data);
    } else {
      // Sync failed or was skipped: previous data stays on screen.
      const reason = result.error || `HTTP ${res.status}`;
      setStatus(`Sync failed: ${reason}. Showing previous data.`, 'error');
    }
  } catch (err) {
    setStatus(`Sync failed: ${err.message}. Showing previous data.`, 'error');
  } finally {
    els.syncBtn.disabled = false;
  }
}

els.syncBtn.addEventListener('click', manualSync);
init();
