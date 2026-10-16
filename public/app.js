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
  chartDailygains: document.getElementById('chart-dailygains'),
  body: document.getElementById('ladder-body'),
  tabRanking: document.getElementById('tab-ranking'),
  tabTimeseries: document.getElementById('tab-timeseries'),
  tabDailygains: document.getElementById('tab-dailygains'),
  panelRanking: document.getElementById('panel-ranking'),
  panelTimeseries: document.getElementById('panel-timeseries'),
  panelDailygains: document.getElementById('panel-dailygains'),
  toggleGroup: document.querySelector('.toggle-group'), // top-N group (first)
  tsRangeGroup: document.getElementById('ts-range-group'),
  dgRangeGroup: document.getElementById('dg-range-group'),
};

// Colour palette. Players cycle through it; extra players wrap around.
const LINE_COLORS = [
  '#3ea6ff', '#7c5cff', '#38d39f', '#ffb020', '#ff6b6b',
  '#4dd0e1', '#ba68c8', '#aed581', '#f06292', '#90a4ae',
  '#ff8a65', '#9575cd', '#4db6ac', '#dce775', '#64b5f6',
];

// Stable per-player colour so each player keeps the same colour across all
// tabs (Over Time lines, Daily Gains bars, legends). Assigned by ranking order
// from /api/players and reused everywhere via colorForPlayer(name).
const playerColor = new Map();

function assignPlayerColors(players) {
  playerColor.clear();
  players.forEach((p, i) => {
    playerColor.set(p.name, LINE_COLORS[i % LINE_COLORS.length]);
  });
}

function colorForPlayer(name) {
  if (playerColor.has(name)) return playerColor.get(name);
  // Fallback for a name not seen in the ranking yet: deterministic by hash so
  // it stays stable within a session rather than shifting between renders.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const color = LINE_COLORS[Math.abs(h) % LINE_COLORS.length];
  playerColor.set(name, color);
  return color;
}

// Last fetched history payload and the current top-N selection, so the toggle
// can re-render without re-fetching.
let historyData = { timestamps: [], series: [] };
let topN = 5;

// Day-range filters for the two charts. 7 = last 7 days, 'all' = everything.
let tsRangeDays = 7;
let dgRangeDays = 7;

// Last fetched daily-gains payload, so switching tabs re-renders from cache.
let dailyGainsData = { days: [] };

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

// Build a coloured "+254" / "-30" badge for the last-24h points change.
// Returns null when there's nothing meaningful to show (no baseline or no change).
function deltaBadge(delta) {
  if (delta === null || delta === undefined || delta === 0) return null;
  const up = delta > 0;
  const badge = el(
    'span',
    `delta ${up ? 'delta-up' : 'delta-down'}`,
    `${up ? '+' : '−'}${Math.abs(delta).toLocaleString('en-GB')}`
  );
  badge.title = `${up ? 'Gained' : 'Lost'} ${Math.abs(delta).toLocaleString('en-GB')} points in the last 24h`;
  return badge;
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

    const points = el('span', 'bar-points', p.points.toLocaleString('en-GB'));

    // Delta gets its own always-present column so bars stay aligned whether or
    // not a badge is shown.
    const deltaCell = el('span', 'bar-delta');
    const badge = deltaBadge(p.delta24h);
    if (badge) deltaCell.append(badge);

    row.append(track, points, deltaCell);
    els.graph.append(row);
  }
}

// ── Tab 2: score over time (SVG multi-line chart) ───────────────────────────
// Keep only timestamps within the last `days` (relative to the newest sample),
// and trim each series' points to match. days === 'all' returns input as-is.
function filterHistoryByRange(data, days) {
  if (days === 'all' || data.timestamps.length === 0) return data;
  const newest = new Date(data.timestamps[data.timestamps.length - 1]).getTime();
  const cutoff = newest - days * 24 * 60 * 60 * 1000;
  const keep = (iso) => new Date(iso).getTime() >= cutoff;

  const timestamps = data.timestamps.filter(keep);
  const series = data.series.map((s) => ({
    name: s.name,
    points: s.points.filter((pt) => keep(pt.t)),
  }));
  return { ...data, timestamps, series };
}

function renderTimeseries() {
  const host = els.chartTimeseries;
  host.replaceChildren();

  const { timestamps, series } = filterHistoryByRange(historyData, tsRangeDays);

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
  // Cap the y-axis just above the leader (headroom ~2000) and use a fixed
  // 1500-point gridline step, so the chart uses its full height with clean
  // 0 / 1500 / 3000 / … labels.
  const yStep = 1500;
  const yTop = Math.max(yStep, Math.ceil((maxPoints + 2000) / yStep) * yStep);

  const x = (ms) => margin.left + ((ms - tMin) / tSpan) * plotW;
  const y = (pts) => margin.top + plotH - (pts / yTop) * plotH;

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'ts-svg',
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
  });

  // Y gridlines + labels, one every `yStep` points.
  const ySteps = Math.round(yTop / yStep);
  for (let i = 0; i <= ySteps; i++) {
    const val = yStep * i;
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
  const lines = visible.map((s) => {
    const color = colorForPlayer(s.name);
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

    // s.points is time-ascending; keep it for prev-sample delta lookups.
    return { name: s.name, color, byT, samples: s.points };
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
    // delta = change versus this player's previous sample (the spike size).
    const rows = [];
    lines.forEach((ln, i) => {
      if (ln.byT.has(t)) {
        const val = ln.byT.get(t);
        markers[i].setAttribute('cx', sx);
        markers[i].setAttribute('cy', y(val));
        markers[i].style.display = '';

        const sampleIdx = ln.samples.findIndex((pt) => pt.t === t);
        const delta =
          sampleIdx > 0 ? val - ln.samples[sampleIdx - 1].points : null;

        rows.push({ name: ln.name, color: ln.color, val, delta });
      } else {
        markers[i].style.display = 'none';
      }
    });

    tooltip.replaceChildren();
    tooltip.append(el('div', 'ts-tooltip-time', shortTime(t)));

    // The tooltip is a single grid (dot | name | score | delta). Cells are
    // appended directly so every score lines up in one column and every delta
    // in another, regardless of per-player badge presence.
    for (const r of rows) {
      const dot = el('span', 'ts-tooltip-dot');
      dot.style.background = r.color;
      tooltip.append(dot);
      tooltip.append(el('span', 'ts-tooltip-name', r.name));
      tooltip.append(el('span', 'ts-tooltip-val', r.val.toLocaleString('en-GB')));

      // Delta cell always added (keeps the grid column), badge only when the
      // score changed at this spot — empty cell otherwise, so no stray space.
      const deltaCell = el('span', 'ts-tooltip-delta');
      const badge = deltaBadge(r.delta);
      if (badge) deltaCell.append(badge);
      tooltip.append(deltaCell);
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
  visible.forEach((s) => {
    const item = el('span', 'ts-legend-item');
    const dot = el('span', 'ts-legend-dot');
    dot.style.background = colorForPlayer(s.name);
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

function shortDate(iso) {
  // iso is 'YYYY-MM-DD'. Parse as UTC to match how days were grouped.
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

// ── Tab 3: top 3 point-gainers per day (grouped bar chart) ──────────────────
function renderDailyGains() {
  const host = els.chartDailygains;
  host.replaceChildren();

  const allDays = dailyGainsData.days || [];
  // Range filter: last N day-groups, or all. Data is chronological.
  const days =
    dgRangeDays === 'all' ? allDays : allDays.slice(-dgRangeDays);
  if (days.length === 0) {
    host.append(
      el('p', 'chart-empty', 'No daily gains yet. Bars appear once players gain points across days.')
    );
    return;
  }

  // Geometry.
  const width = 760;
  const height = 360;
  const margin = { top: 16, right: 16, bottom: 48, left: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  let maxGain = 0;
  for (const d of days) for (const g of d.gains) if (g.gain > maxGain) maxGain = g.gain;
  maxGain = maxGain || 1;
  const yTop = niceCeil(maxGain);

  const y = (v) => margin.top + plotH - (v / yTop) * plotH;

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'dg-svg',
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
  });

  // Y gridlines + labels.
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const val = (yTop / ySteps) * i;
    const yy = y(val);
    root.append(svg('line', { x1: margin.left, y1: yy, x2: margin.left + plotW, y2: yy, class: 'dg-grid' }));
    const label = svg('text', { x: margin.left - 8, y: yy + 4, class: 'dg-axis-label', 'text-anchor': 'end' });
    label.textContent = Math.round(val).toLocaleString('en-GB');
    root.append(label);
  }

  // One group of up to 3 bars per day.
  const groupW = plotW / days.length;
  const groupPad = Math.min(18, groupW * 0.15);
  const innerW = groupW - groupPad;

  days.forEach((day, di) => {
    const groupX = margin.left + di * groupW + groupPad / 2;
    const n = day.gains.length;
    const barGap = 4;
    const barW = Math.max(4, (innerW - barGap * (n - 1)) / n);

    day.gains.forEach((g, bi) => {
      const bx = groupX + bi * (barW + barGap);
      const by = y(g.gain);
      const bh = margin.top + plotH - by;
      // Stable per-player colour, consistent with the Over Time tab.
      const color = colorForPlayer(g.name);

      const rect = svg('rect', {
        x: bx, y: by, width: barW, height: bh, rx: 2, fill: color, class: 'dg-bar',
      });
      const title = svg('title', {});
      title.textContent = `${g.name}: +${g.gain.toLocaleString('en-GB')} on ${shortDate(day.date)}`;
      rect.append(title);
      root.append(rect);

      // Value above the bar.
      const vlabel = svg('text', {
        x: bx + barW / 2, y: by - 4, class: 'dg-value', 'text-anchor': 'middle',
      });
      vlabel.textContent = `+${g.gain.toLocaleString('en-GB')}`;
      root.append(vlabel);
    });

    // Day label under the group.
    const dlabel = svg('text', {
      x: groupX + innerW / 2, y: height - 26, class: 'dg-axis-label', 'text-anchor': 'middle',
    });
    dlabel.textContent = shortDate(day.date);
    root.append(dlabel);
  });

  host.append(root);

  // Legend of the distinct players shown, each with their stable colour.
  const seen = new Set();
  const legend = el('div', 'dg-legend');
  for (const day of days) {
    for (const g of day.gains) {
      if (seen.has(g.name)) continue;
      seen.add(g.name);
      const item = el('span', 'ts-legend-item');
      const dot = el('span', 'ts-legend-dot');
      dot.style.background = colorForPlayer(g.name);
      item.append(dot, el('span', null, g.name));
      legend.append(item);
    }
  }
  host.append(legend);
}

function selectTab(tab) {
  const tabs = {
    ranking: { btn: els.tabRanking, panel: els.panelRanking },
    timeseries: { btn: els.tabTimeseries, panel: els.panelTimeseries },
    dailygains: { btn: els.tabDailygains, panel: els.panelDailygains },
  };
  for (const [name, { btn, panel }] of Object.entries(tabs)) {
    const active = name === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    panel.hidden = !active;
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

    const deltaTd = el('td', 'col-delta');
    const badge = deltaBadge(p.delta24h);
    if (badge) deltaTd.append(badge);
    tr.append(deltaTd);

    els.body.append(tr);
  }
}

function render(data) {
  els.lastUpdated.textContent = formatSyncTime(data.lastSuccessfulSync);
  const players = data.players || [];
  // Establish the stable per-player colour mapping (by ranking order) before
  // any chart renders, so colours are consistent across tabs.
  assignPlayerColors(players);
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

async function loadDailyGains() {
  const res = await fetch('/api/daily-gains');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  dailyGainsData = await res.json();
  renderDailyGains();
}

async function init() {
  try {
    const data = await loadPlayers();
    render(data);
    // Secondary charts are non-blocking: the main view is already up.
    loadHistory().catch((err) => console.error('history load failed:', err));
    loadDailyGains().catch((err) => console.error('daily gains load failed:', err));
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
      await loadDailyGains();
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

// Shared handler for a Range toggle group: parses data-range, sets the active
// button, stores the value via setter, then re-renders.
function makeRangeHandler(group, setRange, rerender) {
  return (e) => {
    const btn = e.target.closest('.toggle');
    if (!btn) return;
    const raw = btn.dataset.range;
    setRange(raw === 'all' ? 'all' : Number.parseInt(raw, 10));
    for (const b of group.querySelectorAll('.toggle')) {
      b.classList.toggle('is-active', b === btn);
    }
    rerender();
  };
}

els.syncBtn.addEventListener('click', manualSync);
els.tabRanking.addEventListener('click', () => selectTab('ranking'));
els.tabTimeseries.addEventListener('click', () => selectTab('timeseries'));
els.tabDailygains.addEventListener('click', () => selectTab('dailygains'));
els.toggleGroup.addEventListener('click', onToggleClick);
els.tsRangeGroup.addEventListener(
  'click',
  makeRangeHandler(els.tsRangeGroup, (v) => { tsRangeDays = v; }, renderTimeseries)
);
els.dgRangeGroup.addEventListener(
  'click',
  makeRangeHandler(els.dgRangeGroup, (v) => { dgRangeDays = v; }, renderDailyGains)
);
init();
