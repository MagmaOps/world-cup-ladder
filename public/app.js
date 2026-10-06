// World Cup Ladder — frontend logic.
// States: loading, data available. Sync progress/errors use the status line.

const SVG_NS = 'http://www.w3.org/2000/svg';

const els = {
  syncBtn: document.getElementById('sync-btn'),
  lastUpdated: document.getElementById('last-updated'),
  status: document.getElementById('status'),
  data: document.getElementById('state-data'),
  graph: document.getElementById('graph'),
  chartTimeseries: document.getElementById('chart-timeseries'),
  body: document.getElementById('ladder-body'),
  tabRanking: document.getElementById('tab-ranking'),
  tabTimeseries: document.getElementById('tab-timeseries'),
  panelRanking: document.getElementById('panel-ranking'),
  panelTimeseries: document.getElementById('panel-timeseries'),
  toggleGroup: document.querySelector('.toggle-group'),
};

// Line colours; players beyond this count cycle through the palette.
const LINE_COLORS = [
  '#3ea6ff', '#7c5cff', '#38d39f', '#ffb020', '#ff6b6b',
  '#4dd0e1', '#ba68c8', '#aed581', '#f06292', '#90a4ae',
  '#ff8a65', '#9575cd', '#4db6ac', '#dce775', '#64b5f6',
];

// Last fetched history payload and the current top-N selection, so the toggle
// can re-render without re-fetching.
let historyData = { timestamps: [], series: [] };
let topN = 5;

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

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    node.setAttribute(k, String(v));
  }
  return node;
}

// ── Tab 1: per-player points bar chart ──────────────────────────────────────
function renderGraph(players) {
  els.graph.replaceChildren();
  const maxPoints = Math.max(1, ...players.map((p) => p.points));
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

// ── Tab 2: score over time (SVG multi-line chart) ───────────────────────────
function renderTimeseries() {
  const host = els.chartTimeseries;
  host.replaceChildren();

  const { timestamps, series } = historyData;

  // Need at least two timepoints to draw a meaningful line.
  if (timestamps.length < 2) {
    host.append(
      el(
        'p',
        'chart-empty',
        timestamps.length === 0
          ? 'No history yet. Data points appear here after syncs.'
          : 'Only one sync so far. The trend line appears after the next sync.'
      )
    );
    return;
  }

  // series is pre-sorted by latest points desc, so slice for the top-N view.
  const visible = topN === 'all' ? series : series.slice(0, topN);
  if (visible.length === 0) {
    host.append(el('p', 'chart-empty', 'No players to display.'));
    return;
  }

  // Geometry.
  const width = 760;
  const height = 360;
  const margin = { top: 16, right: 16, bottom: 36, left: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const times = timestamps.map((t) => new Date(t).getTime());
  const tMin = times[0];
  const tMax = times[times.length - 1];
  const tSpan = tMax - tMin || 1;

  let maxPoints = 0;
  for (const s of visible) {
    for (const pt of s.points) if (pt.points > maxPoints) maxPoints = pt.points;
  }
  maxPoints = maxPoints || 1;
  // Round the y-axis top up to a tidy number.
  const yTop = niceCeil(maxPoints);

  const x = (ms) => margin.left + ((ms - tMin) / tSpan) * plotW;
  const y = (pts) => margin.top + plotH - (pts / yTop) * plotH;

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'ts-svg',
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
  });

  // Y gridlines + labels (5 steps).
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const val = (yTop / ySteps) * i;
    const yy = y(val);
    root.append(
      svg('line', {
        x1: margin.left, y1: yy, x2: margin.left + plotW, y2: yy, class: 'ts-grid',
      })
    );
    const label = svg('text', {
      x: margin.left - 8, y: yy + 4, class: 'ts-axis-label', 'text-anchor': 'end',
    });
    label.textContent = Math.round(val).toLocaleString('en-GB');
    root.append(label);
  }

  // X labels: first, middle, last timestamps.
  const xTickIdx = [0, Math.floor((timestamps.length - 1) / 2), timestamps.length - 1];
  for (const idx of [...new Set(xTickIdx)]) {
    const ms = times[idx];
    const label = svg('text', {
      x: x(ms), y: height - 12, class: 'ts-axis-label', 'text-anchor': 'middle',
    });
    label.textContent = shortTime(timestamps[idx]);
    root.append(label);
  }

  // One line per visible player. Map each player's samples onto the shared
  // timeline by timestamp so gaps are handled gracefully. Capture per-player
  // metadata so the hover layer can look up values and dot positions.
  const lines = visible.map((s, i) => {
    const color = LINE_COLORS[i % LINE_COLORS.length];
    const byT = new Map(s.points.map((pt) => [pt.t, pt.points]));

    const coords = [];
    for (const t of timestamps) {
      if (byT.has(t)) coords.push([x(new Date(t).getTime()), y(byT.get(t))]);
    }

    if (coords.length > 0) {
      const d = coords
        .map(([px, py], j) => `${j === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`)
        .join(' ');
      root.append(svg('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, class: 'ts-line' }));

      const [lx, ly] = coords[coords.length - 1];
      root.append(svg('circle', { cx: lx, cy: ly, r: 3, fill: color }));
    }

    return { name: s.name, color, byT };
  });

  // ── Hover layer ────────────────────────────────────────────────────────
  // A vertical scrubber snaps to the nearest timestamp; a marker dot sits on
  // each line at that time; an HTML tooltip lists every visible player's value.
  const scrubber = svg('line', {
    class: 'ts-scrubber', y1: margin.top, y2: margin.top + plotH, x1: 0, x2: 0,
  });
  scrubber.style.display = 'none';
  root.append(scrubber);

  const markers = lines.map(({ color }) => {
    const dot = svg('circle', { r: 4, fill: color, class: 'ts-marker' });
    dot.style.display = 'none';
    root.append(dot);
    return dot;
  });

  // Transparent capture rect over the plot area.
  const capture = svg('rect', {
    x: margin.left, y: margin.top, width: plotW, height: plotH,
    fill: 'transparent', class: 'ts-capture',
  });
  root.append(capture);

  host.append(root);

  const tooltip = el('div', 'ts-tooltip');
  tooltip.style.display = 'none';
  host.append(tooltip);

  const nearestIndex = (ms) => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < times.length; i++) {
      const dist = Math.abs(times[i] - ms);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  };

  const hideHover = () => {
    scrubber.style.display = 'none';
    for (const m of markers) m.style.display = 'none';
    tooltip.style.display = 'none';
  };

  const onMove = (evt) => {
    // Map the pointer into the SVG's viewBox coordinate space.
    const rect = root.getBoundingClientRect();
    const vx = ((evt.clientX - rect.left) / rect.width) * width;
    // Invert the x scale to a time, then snap to the nearest timestamp.
    const ratio = Math.min(1, Math.max(0, (vx - margin.left) / plotW));
    const ms = tMin + ratio * tSpan;
    const idx = nearestIndex(ms);
    const t = timestamps[idx];
    const sx = x(times[idx]);

    scrubber.setAttribute('x1', sx);
    scrubber.setAttribute('x2', sx);
    scrubber.style.display = '';

    // Position markers and build tooltip rows for players present at this time.
    const rows = [];
    lines.forEach((ln, i) => {
      if (ln.byT.has(t)) {
        const val = ln.byT.get(t);
        markers[i].setAttribute('cx', sx);
        markers[i].setAttribute('cy', y(val));
        markers[i].style.display = '';
        rows.push({ name: ln.name, color: ln.color, val });
      } else {
        markers[i].style.display = 'none';
      }
    });

    tooltip.replaceChildren();
    tooltip.append(el('div', 'ts-tooltip-time', shortTime(t)));
    for (const r of rows) {
      const row = el('div', 'ts-tooltip-row');
      const dot = el('span', 'ts-tooltip-dot');
      dot.style.background = r.color;
      row.append(dot, el('span', 'ts-tooltip-name', r.name));
      row.append(el('span', 'ts-tooltip-val', r.val.toLocaleString('en-GB')));
      tooltip.append(row);
    }

    // Position the tooltip in pixel space, flipping to the left of the
    // scrubber when near the right edge so it stays on screen.
    tooltip.style.display = '';
    const pxPerUnit = rect.width / width;
    const scrubberPx = sx * pxPerUnit;
    const ttW = tooltip.offsetWidth;
    let left = scrubberPx + 14;
    if (left + ttW > rect.width) left = scrubberPx - ttW - 14;
    tooltip.style.left = `${Math.max(4, left)}px`;
    tooltip.style.top = `${margin.top * (rect.height / height)}px`;
  };

  capture.addEventListener('mousemove', onMove);
  capture.addEventListener('mouseleave', hideHover);

  // Legend.
  const legend = el('div', 'ts-legend');
  visible.forEach((s, i) => {
    const color = LINE_COLORS[i % LINE_COLORS.length];
    const item = el('span', 'ts-legend-item');
    const dot = el('span', 'ts-legend-dot');
    dot.style.background = color;
    item.append(dot, el('span', null, s.name));
    legend.append(item);
  });
  host.append(legend);
}

function niceCeil(n) {
  if (n <= 10) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  return Math.ceil(n / mag) * mag;
}

function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function selectTab(tab) {
  const ranking = tab === 'ranking';
  els.tabRanking.classList.toggle('is-active', ranking);
  els.tabTimeseries.classList.toggle('is-active', !ranking);
  els.tabRanking.setAttribute('aria-selected', String(ranking));
  els.tabTimeseries.setAttribute('aria-selected', String(!ranking));
  els.panelRanking.hidden = !ranking;
  els.panelTimeseries.hidden = ranking;
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
  const players = data.players || [];
  renderGraph(players);
  renderTable(players);
}

async function loadPlayers() {
  const res = await fetch('/api/players');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadHistory() {
  const res = await fetch('/api/history');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  historyData = await res.json();
  renderTimeseries();
}

async function init() {
  try {
    const data = await loadPlayers();
    render(data);
    // History is non-blocking: the main view is already up.
    loadHistory().catch((err) => console.error('history load failed:', err));
  } catch (err) {
    // Report the error in the status line so the user can retry with Sync.
    setStatus(`Could not load data: ${err.message}`, 'error');
    render({ players: [], lastSuccessfulSync: null });
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
      const data = await loadPlayers();
      render(data);
      await loadHistory();
    } else {
      const reason = result.error || `HTTP ${res.status}`;
      setStatus(`Sync failed: ${reason}. Showing previous data.`, 'error');
    }
  } catch (err) {
    setStatus(`Sync failed: ${err.message}. Showing previous data.`, 'error');
  } finally {
    els.syncBtn.disabled = false;
  }
}

// Top-N toggle: update selection, active state, and re-render from cache.
function onToggleClick(e) {
  const btn = e.target.closest('.toggle');
  if (!btn) return;
  const raw = btn.dataset.topn;
  topN = raw === 'all' ? 'all' : Number.parseInt(raw, 10);

  for (const b of els.toggleGroup.querySelectorAll('.toggle')) {
    b.classList.toggle('is-active', b === btn);
  }
  renderTimeseries();
}

els.syncBtn.addEventListener('click', manualSync);
els.tabRanking.addEventListener('click', () => selectTab('ranking'));
els.tabTimeseries.addEventListener('click', () => selectTab('timeseries'));
els.toggleGroup.addEventListener('click', onToggleClick);
init();
