// SAVI — top toolbar: panel toggles, save-to-device, and export (image/PDF/data).

// ---- localStorage persistence: a LIST of named saved maps on this device ----
// Each entry: { id, name, description, savedAt (ISO), state (captureMapState()) }.
const MAPS_KEY = 'savi.savedMaps';     // JSON array of entries
const ACTIVE_KEY = 'savi.activeMapId'; // id of the currently-loaded saved map
const LEGACY_KEY = 'savi.savedMap';    // old single-map key (migrated once)

function readMaps() {
  try { const a = JSON.parse(localStorage.getItem(MAPS_KEY)); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeMaps(list) {
  try { localStorage.setItem(MAPS_KEY, JSON.stringify(list)); return true; }
  catch { return false; }
}

// One-time migration: fold an old single saved map into the new list.
(function migrateLegacy() {
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (!legacy) return;
  if (!readMaps().length) {
    try {
      const id = newMapId();
      writeMaps([{ id, name: 'My Saved Map', description: '', savedAt: new Date().toISOString(), state: JSON.parse(legacy) }]);
      localStorage.setItem(ACTIVE_KEY, id);
    } catch { /* ignore malformed legacy data */ }
  }
  localStorage.removeItem(LEGACY_KEY);
})();

function newMapId() {
  return 'map_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Most-recently-saved first.
export function listSavedMaps() {
  return readMaps().sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
}
export function getSavedMap(id) {
  return readMaps().find(m => m.id === id) || null;
}
// Upsert: pass an existing id to overwrite, or omit for a new entry. Returns the id.
export function saveNamedMap({ id, name, description, state }) {
  const list = readMaps();
  const now = new Date().toISOString();
  const existing = id && list.find(m => m.id === id);
  if (existing) {
    existing.name = name; existing.description = description || ''; existing.state = state; existing.savedAt = now;
    writeMaps(list);
    return id;
  }
  const newId = newMapId();
  list.push({ id: newId, name, description: description || '', state, savedAt: now });
  writeMaps(list);
  return newId;
}
export function deleteSavedMap(id) {
  writeMaps(readMaps().filter(m => m.id !== id));
}
export function getActiveMapId() { return localStorage.getItem(ACTIVE_KEY) || null; }
export function setActiveMapId(id) { localStorage.setItem(ACTIVE_KEY, id); }
export function clearActiveMapId() { localStorage.removeItem(ACTIVE_KEY); }

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- Save dialog: name + description for the current map ----
function closeSaveDialogs() {
  document.querySelectorAll('.savemap-overlay').forEach(o => o.remove());
}

export function openSaveMapDialog({ name = '', description = '', isEditing = false,
    suggestedName = '', suggestedDescription = '', onSave }) {
  closeSaveDialogs();
  const namePh = suggestedName || 'e.g. Mental-health 211 calls, 2019';
  const descPh = suggestedDescription || 'What this map shows\u2026';
  const overlay = document.createElement('div');
  overlay.className = 'savemap-overlay open';
  overlay.innerHTML = `
    <div class="savemap-modal" role="dialog" aria-modal="true" aria-label="Save Map">
      <div class="savemap-header">
        <span>Save Map</span>
        <button class="savemap-close" type="button" aria-label="Close">\u00d7</button>
      </div>
      <div class="savemap-body">
        <label class="savemap-field">
          <span>Name</span>
          <input type="text" class="savemap-name" maxlength="80" placeholder="${escHtml(namePh)}" />
        </label>
        <label class="savemap-field">
          <span>Description <em>(optional)</em></span>
          <textarea class="savemap-desc" rows="3" maxlength="400" placeholder="${escHtml(descPh)}"></textarea>
        </label>
      </div>
      <div class="savemap-footer">
        ${isEditing ? '<button class="savemap-btn savemap-secondary" data-act="new" type="button">Save as new</button>' : ''}
        <button class="savemap-btn savemap-cancel" type="button">Cancel</button>
        <button class="savemap-btn savemap-primary" data-act="save" type="button">${isEditing ? 'Update' : 'Save'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const nameEl = overlay.querySelector('.savemap-name');
  const descEl = overlay.querySelector('.savemap-desc');
  nameEl.value = name;
  descEl.value = description;

  const close = () => overlay.remove();
  const commit = (asNew) => {
    // Blank fields fall back to the layer-derived suggestion (the placeholder).
    const nm = nameEl.value.trim() || suggestedName.trim();
    if (!nm) { nameEl.classList.add('savemap-invalid'); nameEl.focus(); return; }
    const desc = descEl.value.trim() || suggestedDescription.trim();
    close();
    onSave({ name: nm, description: desc, asNew: !!asNew });
  };

  overlay.querySelector('.savemap-close').addEventListener('click', close);
  overlay.querySelector('.savemap-cancel').addEventListener('click', close);
  overlay.querySelector('[data-act="save"]').addEventListener('click', () => commit(false));
  const newBtn = overlay.querySelector('[data-act="new"]');
  if (newBtn) newBtn.addEventListener('click', () => commit(true));
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  nameEl.addEventListener('input', () => nameEl.classList.remove('savemap-invalid'));
  nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') commit(false); });
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  setTimeout(() => nameEl.focus(), 30);
}

// ---- Saved-maps list: recall (open) or delete stored maps ----
export function openSavedMapsDialog({ getMaps, activeId, onOpen, onDelete }) {
  closeSaveDialogs();
  const overlay = document.createElement('div');
  overlay.className = 'savemap-overlay open';
  overlay.innerHTML = `
    <div class="savemap-modal" role="dialog" aria-modal="true" aria-label="Saved Maps">
      <div class="savemap-header">
        <span>Saved Maps</span>
        <button class="savemap-close" type="button" aria-label="Close">\u00d7</button>
      </div>
      <div class="savemap-list"></div>
    </div>`;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('.savemap-list');
  const close = () => overlay.remove();
  const fmt = iso => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };

  const render = () => {
    const maps = getMaps();
    if (!maps.length) {
      listEl.innerHTML = '<div class="savemap-empty">No saved maps yet. Use \u201cSave Map\u2026\u201d to store the current view on this device.</div>';
      return;
    }
    listEl.innerHTML = '';
    maps.forEach(m => {
      const row = document.createElement('div');
      row.className = 'savemap-row' + (m.id === activeId ? ' active' : '');
      row.innerHTML = `
        <div class="savemap-row-main">
          <div class="savemap-row-name">${escHtml(m.name)}${m.id === activeId ? ' <span class="savemap-badge">current</span>' : ''}</div>
          ${m.description ? `<div class="savemap-row-desc">${escHtml(m.description)}</div>` : ''}
          <div class="savemap-row-meta">Saved ${escHtml(fmt(m.savedAt))}</div>
        </div>
        <div class="savemap-row-actions">
          <button class="savemap-btn savemap-primary" data-act="open" type="button">Open</button>
          <button class="savemap-iconbtn" data-act="del" type="button" title="Delete" aria-label="Delete">\u00d7</button>
        </div>`;
      row.querySelector('[data-act="open"]').addEventListener('click', () => { close(); onOpen(m.id); });
      row.querySelector('[data-act="del"]').addEventListener('click', () => { onDelete(m.id); render(); });
      listEl.appendChild(row);
    });
  };
  render();

  overlay.querySelector('.savemap-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

// ---- Global loading spinner (classic-SAVI style busy indicator) ----
// Reference-counted so overlapping async operations don't hide it prematurely.
let loadingCount = 0;
function ensureSpinner() {
  let ov = document.getElementById('savi-loading');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'savi-loading';
    ov.innerHTML = '<div class="savi-load-box"><div class="savi-spinner"></div>'
      + '<div class="savi-load-msg"></div></div>';
    document.body.appendChild(ov);
  }
  return ov;
}
export function showLoading(msg) {
  const ov = ensureSpinner();
  ov.querySelector('.savi-load-msg').textContent = msg || 'Loading\u2026';
  loadingCount++;
  ov.classList.add('show');
}
export function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) {
    const ov = document.getElementById('savi-loading');
    if (ov) ov.classList.remove('show');
  }
}
// Wrap an async task with the spinner (always hides, even on error).
export async function withLoading(msg, task) {
  showLoading(msg);
  try { return await task(); }
  finally { hideLoading(); }
}

// ---- Small transient toast for user feedback ----
export function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---- Download helper ----
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function stamp() {
  return new Date().toISOString().slice(0, 10);
}

// ---- Export: PNG snapshot of the current map view ----
// Requires the map to be created with preserveDrawingBuffer: true.
export function exportImage(map) {
  map.redraw();
  requestAnimationFrame(() => {
    map.getCanvas().toBlob(blob => {
      if (blob) downloadBlob(blob, `savi-map-${stamp()}.png`);
      else showToast('Image export failed (browser blocked canvas read).');
    }, 'image/png');
  });
}

// ---- Export: printable PDF (map image + legend) via the browser print dialog ----
export function exportPdf(map, { title, legendHtml }) {
  map.redraw();
  requestAnimationFrame(() => {
    const dataUrl = map.getCanvas().toDataURL('image/png');
    const w = window.open('', '_blank');
    if (!w) { showToast('Pop-up blocked — allow pop-ups to export PDF.'); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>${title}</title>
      <style>
        body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin: 24px; color: #1f2933; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        .meta { font-size: 11px; color: #64707d; margin: 0 0 14px; }
        img { max-width: 100%; border: 1px solid #ccc; border-radius: 6px; }
        .legend { margin-top: 16px; font-size: 12px; }
        .legend-block { margin-bottom: 10px; break-inside: avoid; }
        .legend-block-title { font-weight: 600; display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
        .legend-entry { display: flex; align-items: center; gap: 8px; margin: 2px 0; }
        .legend-swatch, .layer-chip { width: 16px; height: 16px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.2); display: inline-block; }
        .legend-swatch.line { height: 4px; } .legend-swatch.circle { border-radius: 50%; }
        @media print { .no-print { display: none; } }
      </style></head><body>
      <h1>${title}</h1>
      <p class="meta">Community Data Map — generated ${new Date().toLocaleString()}<br>Data source: <a href="https://classic.savi.org/savi">SAVI</a> (Social Assets &amp; Vulnerabilities Indicators), a program of the Polis Center at Indiana University Indianapolis — https://classic.savi.org/savi</p>
      <img src="${dataUrl}" alt="Map export" />
      <div class="legend">${legendHtml || ''}</div>
      <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 250); };<\/script>
      </body></html>`);
    w.document.close();
  });
}

// ---- Get a layer's FeatureCollection: prefer baked in-memory data, else fetch its source URL ----
async function layerFeatureCollection(cfg) {
  if (cfg.sourceData && Array.isArray(cfg.sourceData.features)) return cfg.sourceData;
  if (cfg.source) {
    try { return await fetch(cfg.source).then(r => r.json()); } catch { return null; }
  }
  return null;
}

// Flatten a pin's `meta` array ([{type,value}]) into plain top-level props for export.
function flattenProps(props) {
  const out = { ...(props || {}) };
  if (Array.isArray(out.meta)) {
    out.meta.forEach(m => {
      if (m && m.type && !(m.type in out)) out[m.type] = m.value;
    });
    delete out.meta;
  }
  return out;
}

// ---- Export: combined GeoJSON of the active layers (includes custom places + their metadata) ----
export async function exportData(activeCfgs) {
  if (!activeCfgs.length) { showToast('No active layers to export.'); return; }
  const features = [];
  for (const cfg of activeCfgs) {
    const data = await layerFeatureCollection(cfg);
    if (!data) continue;
    (data.features || []).forEach(f => {
      features.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: { ...flattenProps(f.properties), _layer: cfg.id, _layerLabel: cfg.label }
      });
    });
  }
  if (!features.length) { showToast('No feature data available to export.'); return; }
  const fc = { type: 'FeatureCollection', features };
  downloadBlob(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), `savi-data-${stamp()}.geojson`);
}

// ---- CSV cell escape ----
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---- Export: a single layer. GeoJSON for any layer; pins also get a flat CSV option. ----
export async function exportLayer(cfg, format) {
  const data = await layerFeatureCollection(cfg);
  if (!data || !(data.features || []).length) { showToast('This layer has no data to export.'); return; }
  const safe = (cfg.label || cfg.id).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'layer';
  if (format === 'csv') {
    const rows = data.features.map(f => {
      const p = flattenProps(f.properties);
      const g = f.geometry || {};
      if (g.type === 'Point' && Array.isArray(g.coordinates)) {
        p.lng = g.coordinates[0];
        p.lat = g.coordinates[1];
      }
      return p;
    });
    const cols = [];
    rows.forEach(r => Object.keys(r).forEach(k => { if (!cols.includes(k)) cols.push(k); }));
    const lines = [cols.map(csvCell).join(',')];
    rows.forEach(r => lines.push(cols.map(c => csvCell(r[c])).join(',')));
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), `${safe}-${stamp()}.csv`);
    return;
  }
  const fc = {
    type: 'FeatureCollection',
    features: data.features.map(f => ({
      type: 'Feature',
      geometry: f.geometry,
      properties: { ...flattenProps(f.properties), _layer: cfg.id, _layerLabel: cfg.label }
    }))
  };
  downloadBlob(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), `${safe}-${stamp()}.geojson`);
}

// ---- Toolbar icons (inline SVG, themed via currentColor) ----
const ICONS = {
  add: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  view: '<svg viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2z"/><path d="M9 3v16M15 5v16"/></svg>',
  table: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/></svg>',
  export: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  locate: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  profile: '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  newmap: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6M9 15h6"/></svg>',
  share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18"/></svg>'
};
function icon(name) { return `<span class="tb-ico">${ICONS[name] || ''}</span>`; }

// Wrap a button's text so CSS can hide it (icon-only) on narrow screens.
function label(text) { return `<span class="tb-label">${text}</span>`; }

function divider() {
  const d = document.createElement('div');
  d.className = 'tb-divider';
  return d;
}

function closeAllMenus() {
  document.querySelectorAll('.tb-menu.open').forEach(m => {
    m.classList.remove('open');
    if (m._btn) m._btn.setAttribute('aria-expanded', 'false');
  });
}

// A dropdown button + its menu panel. `align` = 'left' | 'right' (default).
function makeDropdown(labelHtml, className, align) {
  const wrap = document.createElement('div');
  wrap.className = 'tb-menu-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tb-btn ' + (className || '');
  btn.innerHTML = labelHtml + ' <span class="tb-caret">\u25be</span>';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'tb-menu' + (align === 'left' ? ' tb-menu-left' : '');
  menu.setAttribute('role', 'menu');
  menu._btn = btn;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !menu.classList.contains('open');
    closeAllMenus();
    if (willOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      if (menu._onOpen) menu._onOpen();
      // Keep the menu within the viewport horizontally. Menus are anchored to the
      // left or right of their button, which can sit near either screen edge once
      // the toolbar wraps, so nudge the menu back on-screen if it would overflow.
      menu.style.transform = '';
      const r = menu.getBoundingClientRect();
      const pad = 6;
      let dx = 0;
      if (r.left < pad) dx = pad - r.left;
      else if (r.right > window.innerWidth - pad) dx = (window.innerWidth - pad) - r.right;
      if (dx) menu.style.transform = `translateX(${Math.round(dx)}px)`;
    }
  });
  // Escape closes the menu and returns focus to its button (focus sits on the
  // button while the menu is open, so listen on the wrap that contains both).
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) { closeAllMenus(); btn.focus(); }
  });
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return { wrap, btn, menu };
}

function menuAction(menu, label, fn) {
  const it = document.createElement('button');
  it.type = 'button';
  it.className = 'tb-menu-item';
  it.setAttribute('role', 'menuitem');
  it.textContent = label;
  it.addEventListener('click', () => { closeAllMenus(); fn(); });
  menu.appendChild(it);
  return it;
}

function menuToggle(menu, label, getChecked, onToggle) {
  const it = document.createElement('button');
  it.type = 'button';
  it.className = 'tb-menu-item tb-menu-check';
  it.setAttribute('role', 'menuitemcheckbox');
  it.textContent = label;
  const render = () => {
    const on = getChecked();
    it.classList.toggle('checked', on);
    it.setAttribute('aria-checked', on ? 'true' : 'false');
  };
  it.addEventListener('click', () => { onToggle(); render(); });
  render();
  menu.appendChild(it);
  return { el: it, render };
}

function menuSep(menu) {
  const s = document.createElement('div');
  s.className = 'tb-menu-sep';
  menu.appendChild(s);
}

// The Map dropdown button — carries the unsaved-changes dot.
let mapMenuBtn = null;

// Show/hide the "unsaved changes" dot on the Map menu button.
export function setSaveDirty(dirty) {
  if (mapMenuBtn) {
    mapMenuBtn.classList.toggle('tb-dirty', !!dirty);
    mapMenuBtn.title = dirty ? 'Unsaved changes — open to Save Map' : 'Save or clear this map';
  }
}

// ---- Address / place search (Nominatim, key-free) + geolocation ----
// Biases results to Central Indiana; calls handlers.onFlyTo({ center, zoom, bbox, label }).
const IN_VIEWBOX = '-87.8,40.8,-84.6,38.6'; // lon_min,lat_max,lon_max,lat_min
let geoAbort = null;

async function geocode(query) {
  if (geoAbort) geoAbort.abort();
  geoAbort = new AbortController();
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0'
    + `&viewbox=${IN_VIEWBOX}&countrycodes=us&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: geoAbort.signal, headers: { 'Accept-Language': 'en-US' } });
  if (!res.ok) throw new Error('geocode failed');
  return res.json();
}

function buildSearchBox(handlers) {
  const box = document.createElement('div');
  box.className = 'tb-search';

  const ico = document.createElement('span');
  ico.className = 'tb-search-ico';
  ico.innerHTML = ICONS.search;

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'tb-search-input';
  input.placeholder = 'Search address or place\u2026';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Search address or place');

  const locateBtn = document.createElement('button');
  locateBtn.type = 'button';
  locateBtn.className = 'tb-search-locate';
  locateBtn.title = 'Use my location';
  locateBtn.innerHTML = ICONS.locate;

  const results = document.createElement('div');
  results.className = 'tb-search-results';
  results.setAttribute('role', 'listbox');
  results.setAttribute('aria-label', 'Search results');

  box.appendChild(ico);
  box.appendChild(input);
  box.appendChild(locateBtn);
  box.appendChild(results);

  const clearResults = () => { results.innerHTML = ''; results.classList.remove('open'); };

  // Group heading inside the dropdown.
  const groupLabel = (text) => {
    const g = document.createElement('div');
    g.className = 'tb-search-group';
    g.textContent = text;
    return g;
  };

  // Render matching geographies (from the map's own data) at the top of the dropdown.
  const renderGeoMatches = (geos) => {
    if (!geos || !geos.length) return;
    results.appendChild(groupLabel('Geographies on the map'));
    geos.forEach(g => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tb-search-item tb-search-geo';
      row.innerHTML = `<span class="tb-search-tag">${escHtml(g.level)}</span>${escHtml(g.name)}`;
      row.title = `${g.name} — ${g.level}`;
      row.addEventListener('click', () => {
        clearResults();
        input.value = g.name;
        handlers.onPickGeo && handlers.onPickGeo(g);
      });
      results.appendChild(row);
    });
  };

  const renderAddressMatches = (items) => {
    if (items && items.length) results.appendChild(groupLabel('Places & addresses'));
    (items || []).forEach(it => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tb-search-item';
      row.textContent = it.display_name;
      row.title = it.display_name;
      row.addEventListener('click', () => {
        clearResults();
        input.value = it.display_name.split(',')[0];
        const center = [Number(it.lon), Number(it.lat)];
        // bbox = [south, north, west, east] per Nominatim.
        const bbox = it.boundingbox && it.boundingbox.map(Number);
        handlers.onFlyTo && handlers.onFlyTo({ center, bbox, label: it.display_name });
      });
      results.appendChild(row);
    });
  };

  let timer = null;
  const run = () => {
    const q = input.value.trim();
    if (q.length < 2) { clearResults(); return; }
    // Instant local geography matches first.
    const geos = (handlers.onSearchGeos && handlers.onSearchGeos(q)) || [];
    results.innerHTML = '';
    renderGeoMatches(geos);
    const loading = document.createElement('div');
    loading.className = 'tb-search-loading';
    loading.textContent = 'Searching addresses\u2026';
    results.appendChild(loading);
    results.classList.add('open');
    geocode(q).then(items => {
      loading.remove();
      renderAddressMatches(items);
      if (!results.querySelector('.tb-search-item')) {
        results.innerHTML = '<div class="tb-search-empty">No matches</div>';
      }
    }).catch(err => {
      if (err.name === 'AbortError') return;
      loading.remove();
      if (!results.querySelector('.tb-search-item')) {
        results.appendChild(Object.assign(document.createElement('div'),
          { className: 'tb-search-empty', textContent: 'Address search unavailable' }));
      }
    });
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 450); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  input.addEventListener('focus', () => { if (results.children.length) results.classList.add('open'); });
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) clearResults(); });

  locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) { showToast('Geolocation not supported by this browser.'); return; }
    locateBtn.classList.add('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locateBtn.classList.remove('locating');
        const center = [pos.coords.longitude, pos.coords.latitude];
        handlers.onFlyTo && handlers.onFlyTo({ center, zoom: 13, label: 'My location' });
      },
      () => { locateBtn.classList.remove('locating'); showToast('Could not get your location.'); },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  return box;
}

// ---- Build the toolbar DOM and wire its buttons ----
// handlers = { panels:[{key,label,el}], onAddData, onOpenTable, onSave, onOpenSavedMaps,
//              onNewMap, onResetLayout, onExportImage, onExportPdf, onExportData }
export function buildToolbar(handlers) {
  const bar = document.getElementById('toolbar');
  bar.innerHTML = '';

  const brand = document.createElement('div');
  brand.className = 'tb-logo';
  brand.setAttribute('aria-label', 'Community Data Map');
  brand.innerHTML = '<span class="tb-logo-mark">Community Data Map</span>'
    + '<span class="tb-logo-sub">Central Indiana</span>';
  bar.appendChild(brand);
  bar.appendChild(divider());

  // Primary action: + Add Data (promoted from the Layers panel).
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tb-btn tb-primary tb-mobile-hide';
  addBtn.innerHTML = icon('add') + label('Data');
  addBtn.title = 'Add a data indicator to the map';
  addBtn.addEventListener('click', () => handlers.onAddData && handlers.onAddData());
  bar.appendChild(addBtn);

  // View menu: panel/tool/control toggles (grouped with separators), then the
  // reset actions, then the Welcome card.
  const view = makeDropdown(icon('view') + label('View'), '', 'left');
  view.wrap.classList.add('tb-mobile-hide');
  view.btn.title = 'Show or hide panels and controls';
  let lastGroup = null;
  const viewToggles = handlers.panels.map(p => {
    if (lastGroup !== null && p.group !== lastGroup) menuSep(view.menu);
    lastGroup = p.group;
    return menuToggle(view.menu, p.label,
      p.isOn ? p.isOn : () => !p.el.classList.contains('hidden'),
      () => (p.onToggle ? p.onToggle() : p.el.classList.toggle('hidden')));
  });
  menuSep(view.menu);
  menuAction(view.menu, 'Reset View', handlers.onResetView);
  menuAction(view.menu, 'Reset Layout', handlers.onResetLayout);
  menuSep(view.menu);
  menuAction(view.menu, 'Welcome Card\u2026', handlers.onOpenHelp);
  // Re-sync checkmarks each time the menu opens (panels can be closed elsewhere).
  view.menu._onOpen = () => viewToggles.forEach(t => t.render());
  bar.appendChild(view.wrap);

  // Compare: open the tabular data view.
  const tableBtn = document.createElement('button');
  tableBtn.type = 'button';
  tableBtn.className = 'tb-btn tb-mobile-hide';
  tableBtn.innerHTML = icon('table') + label('Compare');
  tableBtn.title = 'Compare indicators across geographies in a table';
  tableBtn.addEventListener('click', () => handlers.onOpenTable && handlers.onOpenTable());
  bar.appendChild(tableBtn);

  // Profile: single-geography fact sheet.
  const profBtn = document.createElement('button');
  profBtn.type = 'button';
  profBtn.className = 'tb-btn tb-mobile-hide';
  profBtn.innerHTML = icon('profile') + label('Profile');
  profBtn.title = 'See all indicators for one geography';
  profBtn.addEventListener('click', () => handlers.onOpenProfile && handlers.onOpenProfile());
  bar.appendChild(profBtn);

  const spacer = document.createElement('div');
  spacer.className = 'tb-spacer';
  bar.appendChild(spacer);

  // Address / place search + geolocation (flies the map, drops a marker).
  bar.appendChild(buildSearchBox(handlers));

  const spacer2 = document.createElement('div');
  spacer2.className = 'tb-spacer';
  bar.appendChild(spacer2);

  // Map menu: Save / Saved Maps / New (carries the unsaved-changes dot).
  const mapMenu = makeDropdown(icon('map') + label('Map'), 'tb-map-btn');
  mapMenu.wrap.classList.add('tb-mobile-hide');
  mapMenu.btn.title = 'Save, load, share, or feature maps';
  mapMenuBtn = mapMenu.btn;
  menuAction(mapMenu.menu, 'Featured Maps\u2026', handlers.onOpenFeatured);
  menuAction(mapMenu.menu, 'Import Places (CSV)\u2026', handlers.onImportPlaces);
  menuSep(mapMenu.menu);
  menuAction(mapMenu.menu, 'Save Map\u2026', handlers.onSave);
  menuAction(mapMenu.menu, 'Saved Maps\u2026', handlers.onOpenSavedMaps);
  menuAction(mapMenu.menu, 'Copy Shareable Link', handlers.onCopyLink);
  menuSep(mapMenu.menu);
  const autosaveToggle = menuToggle(mapMenu.menu, 'Autosave',
    handlers.getAutosave || (() => false),
    handlers.onToggleAutosave || (() => {}));
  mapMenu.menu._onOpen = () => autosaveToggle.render();   // reflect current state on open
  bar.appendChild(mapMenu.wrap);
  setSaveDirty(false);

  // New Map: promoted to a visible toolbar button (was buried in the Map menu).
  const newMapBtn = document.createElement('button');
  newMapBtn.type = 'button';
  newMapBtn.className = 'tb-btn tb-mobile-hide';
  newMapBtn.innerHTML = icon('newmap') + label('New Map');
  newMapBtn.title = 'Start a fresh map (clears the current one)';
  newMapBtn.addEventListener('click', () => handlers.onNewMap && handlers.onNewMap());
  bar.appendChild(newMapBtn);

  // Share: one-tap share of the current view (native share sheet on mobile, copy
  // link elsewhere). Promoted from the Map menu's "Copy Shareable Link".
  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.className = 'tb-btn tb-mobile-hide';
  shareBtn.innerHTML = icon('share') + label('Share');
  shareBtn.title = 'Share the current map view';
  shareBtn.addEventListener('click', () => handlers.onShare && handlers.onShare());
  bar.appendChild(shareBtn);

  // Export menu.
  const exp = makeDropdown(icon('export') + label('Export'));
  exp.wrap.classList.add('tb-mobile-hide');
  exp.btn.title = 'Export the map or data';
  menuAction(exp.menu, 'Image (PNG)', handlers.onExportImage);
  menuAction(exp.menu, 'PDF (print)', handlers.onExportPdf);
  menuAction(exp.menu, 'Data (GeoJSON)', handlers.onExportData);
  menuAction(exp.menu, 'Data (CSV)', handlers.onExportCsv);
  bar.appendChild(exp.wrap);

  // Mobile-only hamburger: one menu that gathers every toolbar action/toggle so
  // the individual buttons (hidden on narrow screens via .tb-mobile-hide) remain
  // reachable. Inserted right after the brand so it sits at the far left on phones.
  const burger = makeDropdown(icon('menu'), '', 'left');
  burger.wrap.classList.add('tb-hamburger');
  burger.btn.title = 'Menu';
  burger.btn.setAttribute('aria-label', 'Menu');
  menuAction(burger.menu, 'Add Data\u2026', handlers.onAddData);
  menuAction(burger.menu, 'Compare (Table)\u2026', handlers.onOpenTable);
  menuAction(burger.menu, 'Community Profile\u2026', handlers.onOpenProfile);
  menuSep(burger.menu);
  // Panel / control toggles (same list the View menu shows).
  let bGroup = null;
  const burgerToggles = handlers.panels.map(p => {
    if (bGroup !== null && p.group !== bGroup) menuSep(burger.menu);
    bGroup = p.group;
    return menuToggle(burger.menu, p.label,
      p.isOn ? p.isOn : () => !p.el.classList.contains('hidden'),
      () => (p.onToggle ? p.onToggle() : p.el.classList.toggle('hidden')));
  });
  menuSep(burger.menu);
  menuAction(burger.menu, 'Featured Maps\u2026', handlers.onOpenFeatured);
  menuAction(burger.menu, 'Import Places (CSV)\u2026', handlers.onImportPlaces);
  menuSep(burger.menu);
  menuAction(burger.menu, 'Save Map\u2026', handlers.onSave);
  menuAction(burger.menu, 'Saved Maps\u2026', handlers.onOpenSavedMaps);
  menuAction(burger.menu, 'New Map', handlers.onNewMap);
  menuAction(burger.menu, 'Share\u2026', handlers.onShare);
  menuAction(burger.menu, 'Copy Shareable Link', handlers.onCopyLink);
  menuSep(burger.menu);
  menuAction(burger.menu, 'Export Image (PNG)', handlers.onExportImage);
  menuAction(burger.menu, 'Export PDF (print)', handlers.onExportPdf);
  menuAction(burger.menu, 'Export Data (GeoJSON)', handlers.onExportData);
  menuAction(burger.menu, 'Export Data (CSV)', handlers.onExportCsv);
  menuSep(burger.menu);
  menuAction(burger.menu, 'Reset View', handlers.onResetView);
  menuAction(burger.menu, 'Reset Layout', handlers.onResetLayout);
  const burgerAutosave = menuToggle(burger.menu, 'Autosave',
    handlers.getAutosave || (() => false),
    handlers.onToggleAutosave || (() => {}));
  menuSep(burger.menu);
  menuAction(burger.menu, 'Welcome Card\u2026', handlers.onOpenHelp);
  burger.menu._onOpen = () => { burgerToggles.forEach(t => t.render()); burgerAutosave.render(); };
  bar.insertBefore(burger.wrap, addBtn);

  document.addEventListener('click', closeAllMenus);
}
