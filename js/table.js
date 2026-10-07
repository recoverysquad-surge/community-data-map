// SAVI — Compare (Data Table) view: rows = geographies, columns = data elements
// (indicator + Display + Year). Rows align only within ONE shared Reporting Level,
// mirroring the classic site's constraint that compared items share a geography level.
// Values are pulled lazily from the per-indicator shards (dataset.js getValueMap).
// Download the current table as CSV, Excel (.xlsx, lazy SheetJS) or GeoJSON.

import { loadDataset, getCategories, getIndicators, searchIndicators, getIndicator,
  getLevels, availableDisplays, availableYears, getValueMap } from './dataset.js?v=109';
import { makeModalMovable } from './panels.js?v=109';
import { withLoading } from './toolbar.js?v=109';
import { renderTrend, renderScatter, renderSlope, renderRadar, renderDistribution } from './charts.js?v=109';

// ---- module state (one live table at a time) ----
const M = {
  deps: null,        // { getGeo }
  level: null,       // shared reporting level
  geos: [],          // [{ id, name, geometry }] rows for the current level
  columns: [],       // [{ key, indicatorId, label, display, year, values }]
  sort: { col: -1, dir: 1 },
  heatmap: true,
  colSeq: 0,
  view: 'table',     // 'table'|'chart'|'trend'|'scatter'|'slope'|'radar'|'dist'
  wrap: null,        // the live render container (table or chart)
  selectedOnly: false, // restrict rows to the map's click-to-compare selection
  // Per-chart selections (persist across re-renders; validated by each renderer).
  trendKey: null, scatterX: null, scatterY: null,
  slopeKey: null, slopeYearA: null, slopeYearB: null, distKey: null
};

// View modes and their toggle labels. 'table' + 'chart' render locally; the rest
// are async SVG charts delegated to charts.js.
const VIEWS = [
  ['table', 'Table'], ['chart', 'Bars'], ['trend', 'Trend'],
  ['scatter', 'Scatter'], ['slope', 'Slope'], ['radar', 'Radar'], ['dist', 'Distribution']
];
const CHART_RENDERERS = { trend: renderTrend, scatter: renderScatter, slope: renderSlope,
  radar: renderRadar, dist: renderDistribution };

// Rows to render: all geographies at the level, or (when "Selected only" is on) just
// those in the map's click-to-compare set that belong to the current level.
function visibleGeos() {
  if (!M.selectedOnly) return M.geos;
  const sel = (M.deps && M.deps.getCompareGeos && M.deps.getCompareGeos()) || [];
  const ids = new Set(sel.filter(g => g.level === M.level).map(g => String(g.id)));
  if (!ids.size) return M.geos;
  return M.geos.filter(g => ids.has(String(g.id)));
}

// Render the current view into the live container. Local views (table/bars) render
// synchronously; the SVG comparison charts render async via charts.js.
async function refresh() {
  if (!M.wrap) return;
  if (M.view === 'table') return renderTable(M.wrap);
  if (M.view === 'chart') return renderChart(M.wrap);
  const render = CHART_RENDERERS[M.view];
  if (!render) return renderTable(M.wrap);
  M.wrap.innerHTML = '';
  try {
    await render(M.wrap, buildChartCtx());
  } catch (e) {
    console.error('chart render failed:', e);
    M.wrap.innerHTML = '';
    M.wrap.appendChild(el('p', 'cmp-empty', 'Could not render this chart.'));
  }
}

// The shared working set handed to charts.js. highlightIds = the map's click-to-compare
// selection at the current level (used to emphasize specific geographies).
function buildChartCtx() {
  const sel = (M.deps && M.deps.getCompareGeos && M.deps.getCompareGeos()) || [];
  const highlightIds = new Set(sel.filter(g => g.level === M.level).map(g => String(g.id)));
  return { level: M.level, geos: visibleGeos(), columns: M.columns, highlightIds, state: M, rerender: refresh };
}

// Parse a display string ("10,948", "1.52%", "$1,200") to a number for sort/shading.
function parseNum(s) {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/[$,%\s]/g, ''));
  return isNaN(n) ? null : n;
}

const stamp = () => new Date().toISOString().slice(0, 10);

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- data loading ----

// Load the geographies (rows) for a reporting level via the app's cached getGeo.
async function loadGeos(level) {
  const gj = await M.deps.getGeo(level);
  const feats = (gj && gj.features) || [];
  M.geos = feats
    .map(f => ({ id: f.properties.id, name: f.properties.name, geometry: f.geometry }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// (Re)load one column's value map for the current level + its display/year.
async function loadColumnValues(col) {
  col.values = await getValueMap(col.indicatorId, M.level, col.display, col.year);
}

// Add one indicator as a column at the current level. `prefer` (from a visible map
// layer) supplies a preferred display/year when they're valid here. Returns true if
// a column was actually added. Skips indicators already present or unavailable here.
async function addIndicatorColumn(indicatorId, prefer) {
  if (M.columns.some(c => c.indicatorId === indicatorId)) return false;
  const ind = getIndicator(indicatorId);
  if (!ind) return false;
  const displays = availableDisplays(indicatorId, M.level);
  if (!displays.length) return false;
  let display = (prefer && displays.includes(prefer.display)) ? prefer.display : displays[0];
  const years = availableYears(indicatorId, M.level, display);
  let year = (prefer && years.includes(prefer.year)) ? prefer.year : years[years.length - 1];
  const col = { key: `col_${++M.colSeq}`, indicatorId, label: ind.label, display, year, values: {} };
  await loadColumnValues(col);
  M.columns.push(col);
  return true;
}

// Merge in a column for each indicator layer currently visible on the map (without
// removing columns the user added manually). Returns true if anything was added.
async function syncVisibleColumns(wanted) {
  let added = false;
  for (const w of (wanted || [])) {
    if (await addIndicatorColumn(w.indicatorId, w)) added = true;
  }
  return added;
}

// ---- rendering ----

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderTable(container) {
  container.innerHTML = '';
  if (!M.columns.length) {
    container.appendChild(el('p', 'cmp-empty',
      'No data elements yet. Click “Add Columns” to compare indicators across geographies.'));
    return;
  }

  const geos = visibleGeos();

  // Per-column numeric extents for heat-map shading.
  const extents = M.columns.map(col => {
    let lo = Infinity, hi = -Infinity;
    geos.forEach(g => {
      const n = parseNum(col.values[g.id]);
      if (n == null) return;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    });
    return (lo === Infinity) ? null : { lo, hi };
  });

  const table = el('table', 'cmp-table');
  const thead = el('thead');
  const htr = el('tr');
  htr.appendChild(el('th', 'cmp-geo-h', 'Geography'));
  M.columns.forEach((col, i) => {
    const th = el('th', 'cmp-col-h');
    if (M.sort.col === i) th.classList.add(M.sort.dir > 0 ? 'sort-asc' : 'sort-desc');

    const head = el('div', 'cmp-col-head');
    const title = el('span', 'cmp-col-title', col.label);
    title.title = 'Click to sort';
    title.addEventListener('click', () => {
      if (M.sort.col === i) M.sort.dir *= -1;
      else { M.sort.col = i; M.sort.dir = 1; }
      refresh();
    });
    const rm = el('button', 'cmp-col-rm', '\u00d7');
    rm.title = 'Remove column';
    rm.addEventListener('click', () => {
      M.columns.splice(i, 1);
      if (M.sort.col === i) M.sort = { col: -1, dir: 1 };
      refresh();
    });
    head.appendChild(title);
    head.appendChild(rm);
    th.appendChild(head);

    // Per-column Display + Year selects (constrained to this indicator at the level).
    const ctrls = el('div', 'cmp-col-ctrls');
    const dSel = el('select', 'cmp-mini');
    availableDisplays(col.indicatorId, M.level).forEach(d => {
      const o = el('option', null, d); o.value = d; if (d === col.display) o.selected = true;
      dSel.appendChild(o);
    });
    const ySel = el('select', 'cmp-mini');
    const fillYears = () => {
      ySel.innerHTML = '';
      availableYears(col.indicatorId, M.level, col.display).forEach(y => {
        const o = el('option', null, y); o.value = y; if (y === col.year) o.selected = true;
        ySel.appendChild(o);
      });
    };
    fillYears();
    dSel.addEventListener('change', async () => {
      col.display = dSel.value;
      const years = availableYears(col.indicatorId, M.level, col.display);
      if (!years.includes(col.year)) col.year = years[years.length - 1];
      await loadColumnValues(col);
      refresh();
    });
    ySel.addEventListener('change', async () => {
      col.year = ySel.value;
      await loadColumnValues(col);
      refresh();
    });
    ctrls.appendChild(dSel);
    ctrls.appendChild(ySel);
    th.appendChild(ctrls);

    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  // Sort rows if a column is chosen.
  let rows = geos.slice();
  if (M.sort.col >= 0 && M.columns[M.sort.col]) {
    const col = M.columns[M.sort.col];
    rows.sort((a, b) => {
      const na = parseNum(col.values[a.id]), nb = parseNum(col.values[b.id]);
      if (na == null && nb == null) return 0;
      if (na == null) return 1;            // nulls last
      if (nb == null) return -1;
      return (na - nb) * M.sort.dir;
    });
  }

  const tbody = el('tbody');
  rows.forEach(g => {
    const tr = el('tr');
    const nameTd = el('td', 'cmp-geo');
    nameTd.appendChild(el('span', 'cmp-geo-name', g.name));
    nameTd.appendChild(el('span', 'cmp-geo-id', g.id));
    tr.appendChild(nameTd);
    M.columns.forEach((col, i) => {
      const raw = col.values[g.id];
      const td = el('td', 'cmp-val', raw != null ? raw : '\u2014');
      const ext = extents[i];
      const n = parseNum(raw);
      if (M.heatmap && ext && n != null && ext.hi > ext.lo) {
        const t = (n - ext.lo) / (ext.hi - ext.lo);
        td.style.backgroundColor = `rgba(45, 122, 191, ${(0.08 + t * 0.42).toFixed(3)})`;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

// Chart view: one horizontal-bar small-multiple per column. Bars are ranked
// descending by value; length scales to the column's max, shaded like the heat map.
function renderChart(container) {
  container.innerHTML = '';
  if (!M.columns.length) {
    container.appendChild(el('p', 'cmp-empty',
      'No data elements yet. Click “Add Columns” to compare indicators across geographies.'));
    return;
  }

  const geos = visibleGeos();
  const grid = el('div', 'cmp-charts');
  M.columns.forEach((col) => {
    const card = el('div', 'cmp-chart');

    const head = el('div', 'cmp-chart-head');
    head.appendChild(el('span', 'cmp-chart-title', col.label));
    head.appendChild(el('span', 'cmp-chart-sub', `${col.display} · ${col.year}`));
    card.appendChild(head);

    // Gather + rank this column's values (descending; nulls dropped).
    const items = geos
      .map(g => ({ name: g.name, id: g.id, raw: col.values[g.id], n: parseNum(col.values[g.id]) }))
      .filter(d => d.n != null)
      .sort((a, b) => b.n - a.n);

    if (!items.length) {
      card.appendChild(el('p', 'cmp-chart-empty', 'No values.'));
      grid.appendChild(card);
      return;
    }

    const hi = items[0].n;
    const lo = items[items.length - 1].n;
    const span = hi > lo ? hi - lo : 0;
    const bars = el('div', 'cmp-chart-bars');
    items.forEach(d => {
      const row = el('div', 'cmp-bar-row');
      row.appendChild(el('span', 'cmp-bar-name', d.name));
      const track = el('div', 'cmp-bar-track');
      const fill = el('div', 'cmp-bar-fill');
      fill.style.width = hi > 0 ? `${Math.max(2, (d.n / hi) * 100).toFixed(1)}%` : '2%';
      const t = span > 0 ? (d.n - lo) / span : 1;
      fill.style.backgroundColor = `rgba(45, 122, 191, ${(0.35 + t * 0.55).toFixed(3)})`;
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'cmp-bar-val', d.raw != null ? d.raw : '\u2014'));
      bars.appendChild(row);
    });
    card.appendChild(bars);
    grid.appendChild(card);
  });
  container.appendChild(grid);
}

// ---- column picker (reuses the catalog modal styles) ----
function openColumnPicker(onPick) {
  let overlay = document.getElementById('cmp-picker-overlay');
  if (overlay) { overlay.classList.add('open'); return; }

  overlay = el('div', 'catalog-overlay open');
  overlay.id = 'cmp-picker-overlay';
  const modal = el('div', 'catalog-modal');

  const header = el('div', 'catalog-header');
  header.appendChild(el('span', null, 'Add Columns'));
  const close = el('button', 'catalog-close', '\u00d7');
  close.title = 'Close';
  header.appendChild(close);

  const search = el('input', 'catalog-search');
  search.type = 'search';
  search.placeholder = 'Search indicators\u2026';

  const body = el('div', 'catalog-body');
  modal.appendChild(header);
  modal.appendChild(search);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const render = (query) => {
    body.innerHTML = '';
    const matches = query ? searchIndicators(query) : null;
    getCategories().forEach(cat => {
      let inds = getIndicators(cat.id);
      if (matches) inds = inds.filter(i => matches.includes(i));
      // Only indicators that have data at the current level can be compared.
      inds = inds.filter(i => availableDisplays(i.id, M.level).length > 0);
      if (!inds.length) return;
      const group = el('div', 'catalog-cat');
      group.appendChild(el('div', 'catalog-cat-title', `${cat.label} (${inds.length})`));
      inds.forEach(ind => {
        const it = el('div', 'catalog-item');
        const text = el('div', 'catalog-item-text');
        text.appendChild(el('div', 'catalog-item-label', ind.label));
        text.appendChild(el('div', 'catalog-item-path', ind.path || ''));
        const already = M.columns.some(c => c.indicatorId === ind.id);
        const add = el('button', 'catalog-add', already ? 'Added \u2713' : 'Add');
        if (already) { add.classList.add('added'); }
        add.addEventListener('click', () => {
          onPick(ind.id);
          add.textContent = 'Added \u2713';
          add.classList.add('added');
        });
        it.appendChild(text);
        it.appendChild(add);
        group.appendChild(it);
      });
      body.appendChild(group);
    });
    if (!body.children.length) {
      body.innerHTML = '<p class="catalog-empty">No indicators available at this reporting level.</p>';
    }
  };
  render('');

  search.addEventListener('input', () => render(search.value));
  const dismiss = () => overlay.classList.remove('open');
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
}

// ---- downloads ----
function tableMatrix() {
  const head = ['Geography', 'GeoID', ...M.columns.map(c => `${c.label} — ${c.display} (${c.year})`)];
  const rows = visibleGeos().map(g => [g.name, g.id, ...M.columns.map(c => c.values[g.id] != null ? c.values[g.id] : '')]);
  return [head, ...rows];
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadCsv() {
  const csv = tableMatrix().map(r => r.map(csvCell).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `savi-compare-${stamp()}.csv`);
}

function downloadGeoJson() {
  const features = visibleGeos().map(g => {
    const props = { id: g.id, name: g.name };
    M.columns.forEach(c => {
      const key = `${c.label} (${c.display}, ${c.year})`;
      props[key] = c.values[g.id] != null ? c.values[g.id] : null;
    });
    return { type: 'Feature', geometry: g.geometry, properties: props };
  });
  const fc = { type: 'FeatureCollection', features };
  downloadBlob(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }),
    `savi-compare-${stamp()}.geojson`);
}

let sheetJsPromise = null;
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (sheetJsPromise) return sheetJsPromise;
  sheetJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Failed to load spreadsheet library.'));
    document.head.appendChild(s);
  });
  return sheetJsPromise;
}

async function downloadXlsx(onError) {
  try {
    const XLSX = await loadSheetJs();
    const ws = XLSX.utils.aoa_to_sheet(tableMatrix());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Compare');
    XLSX.writeFile(wb, `savi-compare-${stamp()}.xlsx`);
  } catch (e) {
    if (onError) onError(e.message || 'Excel export failed.');
  }
}

// ---- main entry: open the full-screen Compare modal ----
export async function openTableModal(deps) {
  M.deps = deps;
  await loadDataset();
  const levels = getLevels();

  // Indicator layers currently visible on the map become auto-loaded columns.
  const wanted = (deps.getVisibleColumns && deps.getVisibleColumns()) || [];
  if (!M.level) {
    const w0 = wanted.find(w => w.level && levels.includes(w.level));
    M.level = (w0 && w0.level) || levels[0];
  }

  let overlay = document.getElementById('cmp-overlay');
  if (overlay) {
    // Re-opening: pull in any newly-visible layers + refresh the compare-selection
    // control (the map selection may have changed while the modal was closed).
    const wrap = overlay.querySelector('.cmp-table-wrap');
    M.wrap = wrap;
    const added = await syncVisibleColumns(wanted);
    if (M.syncSelected) M.syncSelected();
    if (added) refresh();
    overlay.classList.add('open');
    return;
  }

  overlay = el('div', 'cmp-overlay open');
  overlay.id = 'cmp-overlay';
  const modal = el('div', 'cmp-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Compare Data');

  // Header bar: title, level select, add columns, heat-map toggle, download, close.
  const bar = el('div', 'cmp-bar');
  bar.appendChild(el('span', 'cmp-title', 'Compare Data'));

  const levelGroup = el('label', 'cmp-level');
  levelGroup.appendChild(el('span', null, 'Reporting Level'));
  const levelSel = el('select', 'cmp-mini');
  levels.forEach(l => {
    const o = el('option', null, l); o.value = l; if (l === M.level) o.selected = true;
    levelSel.appendChild(o);
  });
  levelSel.disabled = levels.length <= 1;
  levelGroup.appendChild(levelSel);
  bar.appendChild(levelGroup);

  const addBtn = el('button', 'cmp-btn cmp-primary cmp-icon', '+');
  addBtn.title = 'Add columns';
  addBtn.setAttribute('aria-label', 'Add columns');
  bar.appendChild(addBtn);

  // View toggle: Table / Bars / Trend / Scatter / Slope / Radar / Distribution.
  const viewToggle = el('div', 'cmp-toggle');
  const viewBtns = VIEWS.map(([key, label]) => {
    const b = el('button', 'cmp-toggle-btn', label);
    b.dataset.view = key;
    b.addEventListener('click', () => { M.view = key; syncViewBtns(); refresh(); });
    viewToggle.appendChild(b);
    return b;
  });
  const syncViewBtns = () => {
    viewBtns.forEach(b => b.classList.toggle('active', b.dataset.view === M.view));
    // Heat map applies only to the Table; the per-row "Selected only" filter stays
    // useful everywhere (charts also use the selection to highlight geographies).
    heatLabel.style.display = M.view === 'table' ? '' : 'none';
  };
  bar.appendChild(viewToggle);

  const heatLabel = el('label', 'cmp-check');
  const heatCb = el('input');
  heatCb.type = 'checkbox';
  heatCb.checked = M.heatmap;
  heatLabel.appendChild(heatCb);
  heatLabel.appendChild(el('span', null, 'Heat map'));
  bar.appendChild(heatLabel);

  // "Selected only" restricts rows to the map's click-to-compare set. Only shown when
  // there is a selection at the current level; the label reports how many.
  const selLabel = el('label', 'cmp-check');
  const selCb = el('input');
  selCb.type = 'checkbox';
  selCb.checked = M.selectedOnly;
  const selText = el('span', null, 'Selected only');
  selLabel.appendChild(selCb);
  selLabel.appendChild(selText);
  bar.appendChild(selLabel);
  const syncSelected = () => {
    const sel = (deps.getCompareGeos && deps.getCompareGeos()) || [];
    const n = sel.filter(g => g.level === M.level).length;
    selText.textContent = n ? `Selected only (${n})` : 'Selected only';
    selLabel.style.display = n ? '' : 'none';
    if (!n && M.selectedOnly) { M.selectedOnly = false; selCb.checked = false; }
  };
  selCb.addEventListener('change', () => { M.selectedOnly = selCb.checked; refresh(); });
  M.syncSelected = syncSelected;
  syncSelected();
  syncViewBtns();

  const spacer = el('div', 'cmp-spacer');
  bar.appendChild(spacer);

  const guardDownload = (fn) => {
    if (!M.columns.length) { alert('Add at least one column to download.'); return; }
    fn();
  };

  // Download dropdown.
  const dlWrap = el('div', 'cmp-menu-wrap');
  const dlBtn = el('button', 'cmp-btn cmp-icon', '\u2913');
  dlBtn.title = 'Download';
  dlBtn.setAttribute('aria-label', 'Download');
  const dlMenu = el('div', 'cmp-menu');
  const mkItem = (label, fn) => {
    const b = el('button', 'cmp-menu-item', label);
    b.addEventListener('click', () => { dlMenu.classList.remove('open'); fn(); });
    dlMenu.appendChild(b);
  };
  mkItem('CSV (.csv)', () => guardDownload(downloadCsv));
  mkItem('Excel (.xlsx)', () => guardDownload(() => downloadXlsx(msg => alert(msg))));
  mkItem('GeoJSON (.geojson)', () => guardDownload(downloadGeoJson));
  dlBtn.addEventListener('click', (e) => { e.stopPropagation(); dlMenu.classList.toggle('open'); });
  dlWrap.appendChild(dlBtn);
  dlWrap.appendChild(dlMenu);
  bar.appendChild(dlWrap);

  const minBtn = el('button', 'cmp-close cmp-min', '\u2212');
  minBtn.title = 'Minimize';
  minBtn.setAttribute('aria-label', 'Minimize');
  bar.appendChild(minBtn);

  const close = el('button', 'cmp-close', '\u00d7');
  close.title = 'Close';
  bar.appendChild(close);

  const container = el('div', 'cmp-table-wrap');

  modal.appendChild(bar);
  modal.appendChild(container);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Load initial geographies for the level, seed columns from visible layers, render.
  M.wrap = container;
  await withLoading('Loading data\u2026', async () => {
    await loadGeos(M.level);
    await syncVisibleColumns(wanted);
  });
  refresh();

  // Wire controls.
  levelSel.addEventListener('change', async () => {
    M.level = levelSel.value;
    await withLoading('Loading data\u2026', async () => {
      await loadGeos(M.level);
      // Re-validate + reload each column for the new level (drop unsupported ones).
      const kept = [];
      for (const col of M.columns) {
        const displays = availableDisplays(col.indicatorId, M.level);
        if (!displays.length) continue;           // indicator not available here
        if (!displays.includes(col.display)) col.display = displays[0];
        const years = availableYears(col.indicatorId, M.level, col.display);
        if (!years.includes(col.year)) col.year = years[years.length - 1];
        await loadColumnValues(col);
        kept.push(col);
      }
      M.columns = kept;
      M.sort = { col: -1, dir: 1 };
    });
    syncSelected();
    refresh();
  });

  addBtn.addEventListener('click', () => openColumnPicker(async (indicatorId) => {
    if (await addIndicatorColumn(indicatorId)) refresh();
  }));

  heatCb.addEventListener('change', () => { M.heatmap = heatCb.checked; refresh(); });

  // Drag-to-move + minimize (shared with Profile) — see panels.js makeModalMovable.
  // onMinimize closes the download menu so it can't hang open over the docked header.
  makeModalMovable({ overlay, modal, bar, minBtn, onMinimize: () => dlMenu.classList.remove('open') });

  const dismiss = () => { overlay.classList.remove('open'); dlMenu.classList.remove('open'); };
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener('click', () => dlMenu.classList.remove('open'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(); });
}
