// SAVI — Compare visualizations. Build-free inline SVG charts that share the
// Compare modal's working set (one reporting level, a set of geographies = rows,
// a set of indicator columns). Each renderer is async because the year-series
// charts (Trend, Slope) pull extra value maps from the dataset shards.
//
// ctx passed by table.js:
//   { level, geos:[{id,name}], columns:[{indicatorId,label,display,year,values}],
//     highlightIds:Set<string>, state:M, rerender:fn }
//   values is a { geoId -> formatted string } map for that column's display+year.

import { getValueMap, availableYears } from './dataset.js?v=107';

const NS = 'http://www.w3.org/2000/svg';

// Distinct, colorblind-friendlyish series palette (cycled for many geographies).
const PALETTE = ['#2d7abf', '#e8743b', '#19a979', '#945ecf', '#e6324b', '#13a4b4',
  '#c78a00', '#2f6f4f', '#d3488a', '#5b6bd6', '#8a8f00', '#6b6b6b'];
const MUTED = '#c9d2db';

// ---- tiny DOM/SVG helpers ----
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function svg(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function svgText(x, y, str, cls, attrs) {
  const t = svg('text', { x, y, class: cls || '', ...(attrs || {}) });
  t.textContent = str;
  return t;
}
function num(s) {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/[$,%\s]/g, ''));
  return isNaN(n) ? null : n;
}
// Compact numeric label for axes.
function fmt(n) {
  if (n == null || isNaN(n)) return '';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(a < 1 ? 2 : 1);
}
function extentOf(vals) {
  let lo = Infinity, hi = -Infinity;
  vals.forEach(v => { if (v == null) return; if (v < lo) lo = v; if (v > hi) hi = v; });
  return lo === Infinity ? null : { lo, hi };
}
function ticks(lo, hi, n = 5) {
  if (lo === hi) return [lo];
  const out = [];
  for (let i = 0; i <= n; i++) out.push(lo + (hi - lo) * (i / n));
  return out;
}
// Deterministic 0..1 jitter from a geo id (stable across re-renders).
function jitter(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
  return ((h >>> 0) % 1000) / 1000;
}
function colorFor(i) { return PALETTE[i % PALETTE.length]; }
function hint(container, msg) { container.appendChild(el('p', 'cmp-empty', msg)); }

// A labelled <select> whose change re-renders the whole chart.
function pickSelect(label, options, current, onChange) {
  const wrap = el('label', 'cmp-chart-pick');
  wrap.appendChild(el('span', null, label));
  const sel = el('select', 'cmp-mini');
  options.forEach(o => {
    const opt = el('option', null, o.label);
    opt.value = o.value;
    if (o.value === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => onChange(sel.value));
  wrap.appendChild(sel);
  return wrap;
}
function colOptions(columns) {
  return columns.map(c => ({ value: c.indicatorId, label: `${c.label} · ${c.display}` }));
}
function findCol(columns, indicatorId) {
  return columns.find(c => c.indicatorId === indicatorId) || columns[0];
}

// Pull a value map per available year for a column; returns { years:[], byYear:{year->map} }.
async function yearMaps(col, level) {
  const years = availableYears(col.indicatorId, level, col.display).map(String);
  const byYear = {};
  for (const y of years) byYear[y] = await getValueMap(col.indicatorId, level, col.display, y);
  return { years, byYear };
}

// =====================================================================
// 1) TREND — multiple geographies as lines over the years of one indicator.
// =====================================================================
export async function renderTrend(container, ctx) {
  const { columns, geos, level, highlightIds, state } = ctx;
  if (!columns.length) return hint(container, 'Add at least one column to chart a trend.');

  const col = findCol(columns, state.trendKey);
  state.trendKey = col.indicatorId;

  const controls = el('div', 'cmp-chart-controls');
  controls.appendChild(pickSelect('Indicator', colOptions(columns), col.indicatorId,
    v => { state.trendKey = v; ctx.rerender(); }));
  container.appendChild(controls);

  const { years, byYear } = await yearMaps(col, level);
  if (years.length < 2) return hint(container, 'This indicator has only one year of data \u2014 try Slope or Distribution.');

  const series = geos.map(g => ({
    id: g.id, name: g.name,
    points: years.map(y => ({ y, n: num(byYear[y][g.id]) })).filter(p => p.n != null)
  })).filter(s => s.points.length);
  if (!series.length) return hint(container, 'No values to chart.');

  const ext = extentOf(series.flatMap(s => s.points.map(p => p.n)));
  const lo = Math.min(0, ext.lo), hi = ext.hi;

  const W = 820, H = 460, m = { t: 16, r: 150, b: 40, l: 60 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const xAt = i => m.l + (years.length > 1 ? i / (years.length - 1) : 0.5) * pw;
  const yAt = n => m.t + ph - ((n - lo) / ((hi - lo) || 1)) * ph;
  const yearIdx = Object.fromEntries(years.map((y, i) => [y, i]));

  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'cmp-svg', preserveAspectRatio: 'xMidYMid meet' });

  ticks(lo, hi).forEach(tv => {
    const y = yAt(tv);
    s.appendChild(svg('line', { x1: m.l, y1: y, x2: m.l + pw, y2: y, class: 'cmp-grid' }));
    s.appendChild(svgText(m.l - 8, y + 4, fmt(tv), 'cmp-axis-lbl', { 'text-anchor': 'end' }));
  });
  years.forEach((y, i) => s.appendChild(svgText(xAt(i), m.t + ph + 22, y, 'cmp-axis-lbl', { 'text-anchor': 'middle' })));
  s.appendChild(svg('line', { x1: m.l, y1: m.t + ph, x2: m.l + pw, y2: m.t + ph, class: 'cmp-axis' }));

  const useHighlight = highlightIds.size > 0;
  const legend = [];
  let ci = 0;
  series.forEach(ser => {
    const isHi = highlightIds.has(String(ser.id));
    const on = useHighlight ? isHi : true;
    const color = on ? colorFor(ci) : MUTED;
    if (on) { legend.push({ name: ser.name, color }); ci++; }
    const pts = ser.points.map(p => `${xAt(yearIdx[p.y])},${yAt(p.n)}`).join(' ');
    const pl = svg('polyline', { points: pts, fill: 'none', stroke: color,
      'stroke-width': on ? 2.4 : 1, 'stroke-opacity': on ? 0.95 : 0.5, class: 'cmp-line' });
    pl.appendChild(svg('title')).textContent = ser.name;
    s.appendChild(pl);
    if (on) ser.points.forEach(p => s.appendChild(svg('circle', { cx: xAt(yearIdx[p.y]), cy: yAt(p.n), r: 2.6, fill: color })));
  });

  // Legend (right gutter).
  legend.slice(0, 14).forEach((L, i) => {
    const ly = m.t + 6 + i * 18;
    s.appendChild(svg('rect', { x: m.l + pw + 16, y: ly - 8, width: 12, height: 4, rx: 2, fill: L.color }));
    s.appendChild(svgText(m.l + pw + 34, ly - 3, L.name, 'cmp-legend-lbl'));
  });

  container.appendChild(s);
}

// =====================================================================
// 2) SCATTER — two indicators (X vs Y), one dot per geography, with r.
// =====================================================================
export async function renderScatter(container, ctx) {
  const { columns, geos, highlightIds, state } = ctx;
  if (columns.length < 2) return hint(container, 'Add at least two columns to plot a correlation.');

  let xc = findCol(columns, state.scatterX);
  let yc = findCol(columns, state.scatterY);
  if (yc.indicatorId === xc.indicatorId) yc = columns.find(c => c.indicatorId !== xc.indicatorId) || yc;
  state.scatterX = xc.indicatorId; state.scatterY = yc.indicatorId;

  const controls = el('div', 'cmp-chart-controls');
  controls.appendChild(pickSelect('X', colOptions(columns), xc.indicatorId, v => { state.scatterX = v; ctx.rerender(); }));
  controls.appendChild(pickSelect('Y', colOptions(columns), yc.indicatorId, v => { state.scatterY = v; ctx.rerender(); }));
  container.appendChild(controls);

  const pts = geos.map(g => ({ id: g.id, name: g.name, x: num(xc.values[g.id]), y: num(yc.values[g.id]) }))
    .filter(p => p.x != null && p.y != null);
  if (pts.length < 2) return hint(container, 'Not enough overlapping values to plot.');

  const ex = extentOf(pts.map(p => p.x)), ey = extentOf(pts.map(p => p.y));
  const padX = (ex.hi - ex.lo) * 0.05 || 1, padY = (ey.hi - ey.lo) * 0.05 || 1;
  const xlo = ex.lo - padX, xhi = ex.hi + padX, ylo = ey.lo - padY, yhi = ey.hi + padY;

  const W = 720, H = 470, m = { t: 18, r: 20, b: 54, l: 66 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const xAt = v => m.l + ((v - xlo) / ((xhi - xlo) || 1)) * pw;
  const yAt = v => m.t + ph - ((v - ylo) / ((yhi - ylo) || 1)) * ph;

  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'cmp-svg', preserveAspectRatio: 'xMidYMid meet' });

  ticks(ylo, yhi).forEach(tv => {
    const y = yAt(tv);
    s.appendChild(svg('line', { x1: m.l, y1: y, x2: m.l + pw, y2: y, class: 'cmp-grid' }));
    s.appendChild(svgText(m.l - 8, y + 4, fmt(tv), 'cmp-axis-lbl', { 'text-anchor': 'end' }));
  });
  ticks(xlo, xhi).forEach(tv => {
    const x = xAt(tv);
    s.appendChild(svgText(x, m.t + ph + 20, fmt(tv), 'cmp-axis-lbl', { 'text-anchor': 'middle' }));
  });
  s.appendChild(svg('line', { x1: m.l, y1: m.t + ph, x2: m.l + pw, y2: m.t + ph, class: 'cmp-axis' }));
  s.appendChild(svg('line', { x1: m.l, y1: m.t, x2: m.l, y2: m.t + ph, class: 'cmp-axis' }));

  // Pearson r + least-squares trend line.
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  pts.forEach(p => { const dx = p.x - mx, dy = p.y - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; });
  const r = (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
  if (sxx > 0) {
    const slope = sxy / sxx, b = my - slope * mx;
    s.appendChild(svg('line', { x1: xAt(xlo), y1: yAt(slope * xlo + b), x2: xAt(xhi), y2: yAt(slope * xhi + b),
      class: 'cmp-trendline' }));
  }

  const useHi = highlightIds.size > 0;
  pts.forEach(p => {
    const isHi = highlightIds.has(String(p.id));
    const on = !useHi || isHi;
    const c = svg('circle', { cx: xAt(p.x), cy: yAt(p.y), r: on ? 5.5 : 4,
      fill: on ? '#2d7abf' : MUTED, 'fill-opacity': on ? 0.8 : 0.6, stroke: '#fff', 'stroke-width': 0.8 });
    c.appendChild(svg('title')).textContent = `${p.name}: ${xc.label}=${xc.values[p.id]}, ${yc.label}=${yc.values[p.id]}`;
    s.appendChild(c);
    if (useHi && isHi) s.appendChild(svgText(xAt(p.x) + 8, yAt(p.y) + 4, p.name, 'cmp-point-lbl'));
  });

  // Axis titles + r.
  s.appendChild(svgText(m.l + pw / 2, H - 14, `${xc.label} (${xc.display})`, 'cmp-axis-title', { 'text-anchor': 'middle' }));
  const yt = svgText(16, m.t + ph / 2, `${yc.label} (${yc.display})`, 'cmp-axis-title',
    { 'text-anchor': 'middle', transform: `rotate(-90 16 ${m.t + ph / 2})` });
  s.appendChild(yt);
  s.appendChild(svgText(m.l + pw - 6, m.t + 14, `r = ${r.toFixed(2)}`, 'cmp-stat', { 'text-anchor': 'end' }));

  container.appendChild(s);
}

// =====================================================================
// 3) SLOPE — one indicator, two years, a line per geography (rank shift).
// =====================================================================
export async function renderSlope(container, ctx) {
  const { columns, geos, level, highlightIds, state } = ctx;
  if (!columns.length) return hint(container, 'Add at least one column to draw a slope chart.');

  const col = findCol(columns, state.slopeKey);
  state.slopeKey = col.indicatorId;
  const years = availableYears(col.indicatorId, level, col.display).map(String);
  if (years.length < 2) return hint(container, 'This indicator needs at least two years for a slope chart.');

  let ya = years.includes(state.slopeYearA) ? state.slopeYearA : years[0];
  let yb = years.includes(state.slopeYearB) ? state.slopeYearB : years[years.length - 1];
  if (ya === yb) { ya = years[0]; yb = years[years.length - 1]; }
  state.slopeYearA = ya; state.slopeYearB = yb;

  const controls = el('div', 'cmp-chart-controls');
  controls.appendChild(pickSelect('Indicator', colOptions(columns), col.indicatorId, v => { state.slopeKey = v; ctx.rerender(); }));
  controls.appendChild(pickSelect('From', years.map(y => ({ value: y, label: y })), ya, v => { state.slopeYearA = v; ctx.rerender(); }));
  controls.appendChild(pickSelect('To', years.map(y => ({ value: y, label: y })), yb, v => { state.slopeYearB = v; ctx.rerender(); }));
  container.appendChild(controls);

  const mapA = await getValueMap(col.indicatorId, level, col.display, ya);
  const mapB = await getValueMap(col.indicatorId, level, col.display, yb);
  const rows = geos.map(g => ({ id: g.id, name: g.name, a: num(mapA[g.id]), b: num(mapB[g.id]) }))
    .filter(d => d.a != null && d.b != null);
  if (!rows.length) return hint(container, 'No geographies have values in both years.');

  const ext = extentOf(rows.flatMap(d => [d.a, d.b]));
  const lo = ext.lo, hi = ext.hi;

  const W = 720, H = 480, m = { t: 30, r: 150, b: 24, l: 150 };
  const ph = H - m.t - m.b;
  const xa = m.l, xb = W - m.r;
  const yAt = n => m.t + ph - ((n - lo) / ((hi - lo) || 1)) * ph;

  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'cmp-svg', preserveAspectRatio: 'xMidYMid meet' });
  s.appendChild(svg('line', { x1: xa, y1: m.t, x2: xa, y2: m.t + ph, class: 'cmp-axis' }));
  s.appendChild(svg('line', { x1: xb, y1: m.t, x2: xb, y2: m.t + ph, class: 'cmp-axis' }));
  s.appendChild(svgText(xa, m.t - 12, ya, 'cmp-axis-title', { 'text-anchor': 'middle' }));
  s.appendChild(svgText(xb, m.t - 12, yb, 'cmp-axis-title', { 'text-anchor': 'middle' }));

  const useHi = highlightIds.size > 0;
  rows.forEach(d => {
    const isHi = highlightIds.has(String(d.id));
    const on = !useHi || isHi;
    const up = d.b >= d.a;
    const color = !on ? MUTED : (up ? '#19a979' : '#e6324b');
    const ay = yAt(d.a), by = yAt(d.b);
    s.appendChild(svg('line', { x1: xa, y1: ay, x2: xb, y2: by, stroke: color,
      'stroke-width': on ? 2 : 1, 'stroke-opacity': on ? 0.9 : 0.4 }));
    s.appendChild(svg('circle', { cx: xa, cy: ay, r: on ? 3.5 : 2.5, fill: color }));
    s.appendChild(svg('circle', { cx: xb, cy: by, r: on ? 3.5 : 2.5, fill: color }));
    if (on) {
      s.appendChild(svgText(xa - 8, ay + 4, `${d.name} ${fmt(d.a)}`, 'cmp-slope-lbl', { 'text-anchor': 'end' }));
      s.appendChild(svgText(xb + 8, by + 4, `${fmt(d.b)} ${d.name}`, 'cmp-slope-lbl', { 'text-anchor': 'start' }));
    }
  });

  container.appendChild(s);
}

// =====================================================================
// 4) RADAR — several indicators (axes) with a few geographies overlaid.
// =====================================================================
export async function renderRadar(container, ctx) {
  const { columns, geos, highlightIds } = ctx;
  if (columns.length < 3) return hint(container, 'Add at least three columns to draw a radar chart.');

  // Normalize each indicator 0..1 across the working geographies.
  const norms = columns.map(c => {
    const ext = extentOf(geos.map(g => num(c.values[g.id])));
    return ext || { lo: 0, hi: 1 };
  });

  // Subjects: the click-to-compare selection, else the first few geographies.
  let subjects = geos.filter(g => highlightIds.has(String(g.id)));
  if (!subjects.length) subjects = geos.slice(0, 4);
  if (!subjects.length) return hint(container, 'No geographies to chart.');

  const controls = el('div', 'cmp-chart-controls');
  controls.appendChild(el('span', 'cmp-chart-note', highlightIds.size
    ? `Comparing ${subjects.length} selected geograph${subjects.length === 1 ? 'y' : 'ies'} across ${columns.length} indicators.`
    : `Showing the first ${subjects.length} geographies \u2014 use "Add to compare" on the map to pick specific ones.`));
  container.appendChild(controls);

  const W = 720, H = 520, cx = W / 2, cy = H / 2 + 10, R = 175;
  const N = columns.length;
  const angle = i => (i / N) * Math.PI * 2 - Math.PI / 2;
  const at = (i, t) => [cx + Math.cos(angle(i)) * R * t, cy + Math.sin(angle(i)) * R * t];

  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'cmp-svg', preserveAspectRatio: 'xMidYMid meet' });

  // Concentric rings + spokes + axis labels.
  [0.25, 0.5, 0.75, 1].forEach(t => {
    const ring = columns.map((_, i) => at(i, t).join(',')).join(' ');
    s.appendChild(svg('polygon', { points: ring, class: 'cmp-radar-ring', fill: 'none' }));
  });
  columns.forEach((c, i) => {
    const [ex, ey] = at(i, 1);
    s.appendChild(svg('line', { x1: cx, y1: cy, x2: ex, y2: ey, class: 'cmp-grid' }));
    const [lx, ly] = at(i, 1.12);
    const anchor = Math.abs(Math.cos(angle(i))) < 0.3 ? 'middle' : (Math.cos(angle(i)) > 0 ? 'start' : 'end');
    const label = c.label.length > 22 ? c.label.slice(0, 21) + '\u2026' : c.label;
    s.appendChild(svgText(lx, ly + 4, label, 'cmp-radar-axis', { 'text-anchor': anchor }));
  });

  subjects.forEach((g, si) => {
    const color = colorFor(si);
    const pts = columns.map((c, i) => {
      const nm = norms[i];
      const v = num(c.values[g.id]);
      const t = v == null ? 0 : (nm.hi > nm.lo ? (v - nm.lo) / (nm.hi - nm.lo) : 0.5);
      return at(i, Math.max(0.02, t)).join(',');
    }).join(' ');
    s.appendChild(svg('polygon', { points: pts, fill: color, 'fill-opacity': 0.12, stroke: color, 'stroke-width': 2 }));
    columns.forEach((c, i) => {
      const nm = norms[i], v = num(c.values[g.id]);
      const t = v == null ? 0 : (nm.hi > nm.lo ? (v - nm.lo) / (nm.hi - nm.lo) : 0.5);
      const [px, py] = at(i, Math.max(0.02, t));
      const dot = svg('circle', { cx: px, cy: py, r: 3, fill: color });
      dot.appendChild(svg('title')).textContent = `${g.name} — ${c.label}: ${c.values[g.id] != null ? c.values[g.id] : '\u2014'}`;
      s.appendChild(dot);
    });
    // Legend.
    const ly = 24 + si * 18;
    s.appendChild(svg('rect', { x: 16, y: ly - 9, width: 12, height: 12, rx: 2, fill: color }));
    s.appendChild(svgText(34, ly + 1, g.name, 'cmp-legend-lbl'));
  });

  container.appendChild(s);
}

// =====================================================================
// 5) DISTRIBUTION — one indicator, every geography as a jittered dot with
//    mean/median markers; selected geographies highlighted + labelled.
// =====================================================================
export async function renderDistribution(container, ctx) {
  const { columns, geos, highlightIds, state } = ctx;
  if (!columns.length) return hint(container, 'Add at least one column to see its distribution.');

  const col = findCol(columns, state.distKey);
  state.distKey = col.indicatorId;

  const controls = el('div', 'cmp-chart-controls');
  controls.appendChild(pickSelect('Indicator', colOptions(columns), col.indicatorId, v => { state.distKey = v; ctx.rerender(); }));
  container.appendChild(controls);

  const rows = geos.map(g => ({ id: g.id, name: g.name, n: num(col.values[g.id]), raw: col.values[g.id] }))
    .filter(d => d.n != null);
  if (!rows.length) return hint(container, 'No values to chart.');

  const ext = extentOf(rows.map(d => d.n));
  const lo = ext.lo, hi = ext.hi;
  const mean = rows.reduce((a, d) => a + d.n, 0) / rows.length;
  const sorted = rows.map(d => d.n).sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  const W = 760, H = 240, m = { t: 24, r: 24, b: 46, l: 24 };
  const pw = W - m.l - m.r, band = H - m.t - m.b;
  const xAt = v => m.l + ((v - lo) / ((hi - lo) || 1)) * pw;
  const yBase = m.t, yH = band;

  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'cmp-svg', preserveAspectRatio: 'xMidYMid meet' });

  // Axis line + ticks.
  const axisY = m.t + band + 8;
  s.appendChild(svg('line', { x1: m.l, y1: axisY, x2: m.l + pw, y2: axisY, class: 'cmp-axis' }));
  ticks(lo, hi).forEach(tv => {
    const x = xAt(tv);
    s.appendChild(svg('line', { x1: x, y1: axisY, x2: x, y2: axisY + 5, class: 'cmp-axis' }));
    s.appendChild(svgText(x, axisY + 20, fmt(tv), 'cmp-axis-lbl', { 'text-anchor': 'middle' }));
  });

  // Mean (solid) + median (dashed) markers.
  s.appendChild(svg('line', { x1: xAt(mean), y1: yBase, x2: xAt(mean), y2: yBase + yH, class: 'cmp-stat-line' }));
  s.appendChild(svgText(xAt(mean), yBase - 6, `mean ${fmt(mean)}`, 'cmp-stat', { 'text-anchor': 'middle' }));
  s.appendChild(svg('line', { x1: xAt(median), y1: yBase, x2: xAt(median), y2: yBase + yH, class: 'cmp-stat-line dashed' }));

  const useHi = highlightIds.size > 0;
  rows.forEach(d => {
    const isHi = highlightIds.has(String(d.id));
    const on = !useHi || isHi;
    const cy = yBase + 10 + jitter(d.id) * (yH - 20);
    const dot = svg('circle', { cx: xAt(d.n), cy, r: on ? 6 : 4.5,
      fill: on ? '#2d7abf' : MUTED, 'fill-opacity': on ? 0.85 : 0.55, stroke: '#fff', 'stroke-width': 0.8 });
    dot.appendChild(svg('title')).textContent = `${d.name}: ${d.raw}`;
    s.appendChild(dot);
    if (useHi && isHi) s.appendChild(svgText(xAt(d.n), cy - 9, d.name, 'cmp-point-lbl', { 'text-anchor': 'middle' }));
  });

  s.appendChild(svgText(m.l, H - 6, `${col.label} · ${col.display} (${col.year})`, 'cmp-axis-title', { 'text-anchor': 'start' }));
  container.appendChild(s);
}
