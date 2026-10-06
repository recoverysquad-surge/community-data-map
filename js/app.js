// SAVI Single-Map Interface — app entry point.
// Initializes MapLibre, loads the layer catalog, and wires up UI.

import { addLayer, updateLayerVisibility, updateLayerOpacity, bindPopups, reAddAllLayers, applyLayerOrder, setLayerColor, setLayerPattern, setLayerPatternOpacity, setLayerRamp, reclassify, removeLayer, applyIndicatorSelection, RAMPS } from './layers.js?v=101';
import { buildLayerPanel, buildLegend, buildBasemapSwitcher, openCatalogModal } from './ui.js?v=101';
import { makeDraggable, makeCollapsible, makeResizable, resetPanelLayout } from './panels.js?v=101';
import { buildToolbar, showToast, exportImage, exportPdf, exportData, exportLayer, setSaveDirty,
  listSavedMaps, getSavedMap, saveNamedMap, deleteSavedMap,
  getActiveMapId, setActiveMapId, clearActiveMapId, withLoading,
  openSaveMapDialog, openSavedMapsDialog, downloadBlob, stamp } from './toolbar.js?v=101';
import { ANY, loadDataset, getCategories, getIndicator, getLevels, availableYears, resolveSelection, getValueMap, geometryFor } from './dataset.js?v=101';
import { openTableModal } from './table.js?v=101';
import { openProfileModal } from './profile.js?v=101';
import { openSwipe, closeSwipe, isSwipeOpen } from './swipe.js?v=101';
import { openMetadataModal } from './metadata.js?v=101';
import { openWelcomeCard } from './welcome.js?v=101';
import { openHelpPanel } from './help.js?v=101';
import { openFeaturedGallery } from './featured.js?v=101';
import { openImportPlaces } from './import_places.js?v=101';
import { openImportGeojson } from './import_geojson.js?v=101';

// ---- Basemap definitions (all key-free) ----
export const BASEMAPS = {
  light: {
    label: 'Light',
    // Esri Light Gray Canvas — key-free (same public ArcGIS server as Satellite).
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Tiles © Esri — Light Gray Canvas'
  },
  streets: {
    label: 'Streets',
    tiles: [
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
    ],
    attribution: '© OpenStreetMap contributors'
  },
  satellite: {
    label: 'Satellite',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Tiles © Esri — World Imagery'
  },
  hybrid: {
    label: 'Hybrid',
    // Satellite imagery base + transparent Esri reference overlays (roads, then labels/places).
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    overlays: [
      ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'],
      ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}']
    ],
    attribution: 'Tiles © Esri — World Imagery, Reference'
  }
};

function basemapStyle(key) {
  const bm = BASEMAPS[key];
  const sources = {
    basemap: { type: 'raster', tiles: bm.tiles, tileSize: 256, attribution: bm.attribution }
  };
  const layers = [{ id: 'basemap', type: 'raster', source: 'basemap' }];
  // Optional transparent raster overlays stacked above the base (e.g. Hybrid labels/roads).
  (bm.overlays || []).forEach((tiles, i) => {
    const id = `basemap-ov${i}`;
    sources[id] = { type: 'raster', tiles, tileSize: 256 };
    layers.push({ id, type: 'raster', source: id });
  });
  return { version: 8, sources, layers };
}

// ---- App state ----
const state = {
  map: null,
  catalog: null,
  currentBasemap: 'hybrid',   // default for new visitors + New Map (saved maps restore their own)
  buildings3d: false, // OpenFreeMap 3D building extrusion overlay (toggle)
  activeLayerIds: new Set(),
  layerOrder: [],
  geoCache: {},     // reporting level -> loaded geometry FeatureCollection
  catIdByLabel: {}, // dataset category label -> id
  dynSeq: 0,        // counter for unique dynamic layer ids
  placesSeq: 0,     // counter for unique Places (pin) layer ids
  importedSeq: 0,   // counter for unique imported (GeoJSON/KML) layer ids
  activeMapId: null, // id of the currently-loaded saved map (from the saved-maps list)
  autosave: true,  // auto-save the active map on changes (on by default; init reads the pref)
  autosaveTimer: null, // debounce handle for autosave
  geolocate: null,  // MapLibre GeolocateControl (live "my location" dot)
  navCtrl: null,    // MapLibre NavigationControl (zoom + compass)
  fsCtrl: null,     // MapLibre FullscreenControl
  scaleCtrl: null,  // MapLibre ScaleControl (distance bar)
  searchMarker: null, // reusable marker for address/place search + geolocation
  highlightData: null, // GeoJSON of the currently highlighted geography (feature search)
  legendHighlight: null, // { layerId, indices:[...] } of emphasized choropleth breaks, or null
  timelineTouched: false, // has the user manually toggled the Timeline panel? (stops auto-show)
  compareSet: []    // click-to-compare selection: [{ level, id, name }]
};

// --- Map control show/hide (View menu), persisted to localStorage; all default ON. ---
const CONTROL_PREF_KEYS = { zoom: 'savi.ui.zoom', fullscreen: 'savi.ui.fullscreen', locate: 'savi.ui.locate', scale: 'savi.ui.scale' };
function controlPref(which) {
  try { return localStorage.getItem(CONTROL_PREF_KEYS[which]) !== '0'; } catch { return true; }
}
function setControlPref(which, on) {
  try { localStorage.setItem(CONTROL_PREF_KEYS[which], on ? '1' : '0'); } catch { /* ignore */ }
}
function controlEl(which) {
  if (which === 'fullscreen') {
    // FullscreenControl._container is the fullscreen TARGET (the #app element);
    // its button lives on ._controlContainer. Hiding ._container blanks the app.
    return state.fsCtrl && state.fsCtrl._controlContainer ? state.fsCtrl._controlContainer : null;
  }
  const ctrl = which === 'zoom' ? state.navCtrl : which === 'scale' ? state.scaleCtrl : state.geolocate;
  return ctrl && ctrl._container ? ctrl._container : null;
}
function applyControlVisibility() {
  for (const which of ['zoom', 'fullscreen', 'locate', 'scale']) {
    const el = controlEl(which);
    if (el) el.style.display = controlPref(which) ? '' : 'none';
  }
}

// Fetch (and cache) the geometry for a reporting level.
async function getGeo(level) {
  if (!state.geoCache[level]) {
    const meta = geometryFor(level);
    state.geoCache[level] = await fetch(meta.geometry).then(r => r.json());
  }
  return state.geoCache[level];
}

// Create a dynamic indicator layer config, resolving its selection to concrete data.
// map is null when preparing a layer before the map/load (seeding, restore).
async function createIndicatorCfg(indicatorId, sel, style, idOverride) {
  const ind = getIndicator(indicatorId);
  if (!ind) return null;
  sel = sel || { level: ANY, display: ANY, year: ANY };
  const resolved = resolveSelection(indicatorId, sel);
  if (!resolved) return null;

  const meta = geometryFor(resolved.level);
  const geojson = await getGeo(resolved.level);
  const valueMap = await getValueMap(indicatorId, resolved.level, resolved.display, resolved.year);

  const cfg = {
    id: idOverride || `dyn_${++state.dynSeq}`,
    label: ind.label,
    category: state.catIdByLabel[ind.category] || ind.category,
    kind: 'indicator',
    indicatorId,
    sel: { ...sel },
    geometry: 'polygon',
    visible: true,
    opacity: (style && style.opacity != null) ? style.opacity : 0.8,
    ramp: (style && style.ramp) || 'warm',
    pattern: (style && style.pattern) || 'none',
    patternColor: style && style.patternColor,
    patternOpacity: (style && style.patternOpacity != null) ? style.patternOpacity : 1,
    classify: (style && style.classify) || undefined,
    paint: { 'line-color': '#666', 'line-width': 0.75 }
  };
  applyIndicatorSelection(state.map, cfg, {
    ...resolved, geojson, valueMap, idProp: meta.idProp, nameProp: meta.nameProp
  });
  return cfg;
}

// Build a multi-year trend sparkline (SVG) for a single geography, appended to
// an indicator layer's click popup. Returns HTML, or null when there's no
// meaningful series (non-indicator layer, <2 numeric points).
async function buildTrendSparkline(cfg, props) {
  if (!cfg || cfg.kind !== 'indicator' || !cfg.indicatorId || props.id == null) return null;
  const years = availableYears(cfg.indicatorId, cfg.level, cfg.display);
  if (!years || years.length < 2) return null;

  const num = (s) => {
    if (s == null || s === '') return null;
    const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const maps = await Promise.all(years.map(y => getValueMap(cfg.indicatorId, cfg.level, cfg.display, y)));
  const pts = [];
  years.forEach((y, i) => {
    const raw = maps[i][props.id];
    const v = num(raw);
    if (v != null) pts.push({ year: y, v, raw: raw != null ? String(raw) : String(v) });
  });
  if (pts.length < 2) return null;

  const W = 224, H = 46, PX = 6, PY = 8;
  const vals = pts.map(p => p.v);
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
  const n = pts.length;
  const xAt = (i) => PX + (n === 1 ? 0 : i * (W - 2 * PX) / (n - 1));
  const yAt = (v) => H - PY - ((v - min) / span) * (H - 2 * PY);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(p.v).toFixed(1)}`).join(' ');
  const curIdx = pts.findIndex(p => String(p.year) === String(cfg.year));
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const escAttr = (s) => esc(s).replace(/'/g, '&#39;');

  const dots = pts.map((p, i) => {
    const cur = i === curIdx;
    const cx = xAt(i).toFixed(1), cy = yAt(p.v).toFixed(1);
    const readout = escAttr(`${p.year}: ${p.raw}`);
    // Visible dot + a larger transparent hit target that drives the hover
    // readout (and a native tooltip for good measure).
    return `<circle cx="${cx}" cy="${cy}" r="${cur ? 3.2 : 1.8}"`
      + ` fill="${cur ? 'var(--accent-bright)' : 'var(--accent-deep)'}"${cur ? ' stroke="#fff" stroke-width="1"' : ''}/>`
      + `<circle class="savi-trend-hit" cx="${cx}" cy="${cy}" r="7" fill="transparent"`
      + ` onmouseenter="__saviSparkHover(this,'${readout}')" onmouseleave="__saviSparkHover(this,'')">`
      + `<title>${esc(`${p.year}: ${p.raw}`)}</title></circle>`;
  }).join('');
  const caption = `Trend${cfg.display ? ' \u00b7 ' + esc(cfg.display) : ''}`;
  const initial = curIdx >= 0 ? `${pts[curIdx].year}: ${pts[curIdx].raw}` : '';

  return `<div class="savi-trend-caption">${caption}</div>`
    + `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Multi-year trend">`
    + `<path d="${path}" fill="none" stroke="var(--accent-deep)" stroke-width="1.5" stroke-linejoin="round"/>${dots}</svg>`
    + `<div class="savi-trend-readout" data-default="${escAttr(initial)}">${esc(initial)}</div>`
    + `<div class="savi-trend-range"><span>${esc(pts[0].year)}</span><span>${esc(pts[n - 1].year)}</span></div>`;
}

// Hover handler for sparkline points: updates the readout under the SVG. Empty
// text restores the default (current-year) readout. Global because it is wired
// via inline attributes on SVG injected through innerHTML.
window.__saviSparkHover = function (el, text) {
  const box = el.closest('.savi-popup-trend');
  const out = box && box.querySelector('.savi-trend-readout');
  if (!out) return;
  out.textContent = text || out.getAttribute('data-default') || '';
};

async function init() {
  // Restore the autosave preference (ON by default). Only an explicit '0' (user turned
  // it off) disables it; a missing key — i.e. a first-time visitor — defaults to on.
  try { state.autosave = localStorage.getItem('savi.autosave') !== '0'; } catch { /* ignore */ }

  // Load layer catalog + the harvested indicator dataset (drives the selectors).
  const [catalog] = await Promise.all([
    fetch('data/layers.json').then(r => r.json()),
    loadDataset()
  ]);
  state.catalog = catalog;

  // Build the geography name index in the background so the search box can match
  // county/tract names (dataset is loaded now, so getLevels/getGeo work).
  buildGeoIndex().then(idx => { geoIndex = idx; });

  // Drop the old baked 211 choropleth layers — they're now dynamic indicator layers.
  catalog.layers = catalog.layers.filter(l => l._generated !== 'savi211');
  catalog.categories = catalog.categories.filter(c => c.id !== 'calls211');

  // Remember the pristine static catalog layers (e.g. the default Counties boundary
  // and the Sites point layers) so Add Data can re-create one after the user fully
  // deletes it from the layer panel.
  catalog.layers.forEach(l => { defaultStaticCfgs[l.id] = JSON.parse(JSON.stringify(l)); });

  // The Sites / Programs & Agencies point layers are NOT part of the default map.
  // They only enter the panel when the user explicitly adds one via Add Data, and
  // once removed they must stay gone (no auto-reappear on New Map / reload). Their
  // pristine clones live in defaultStaticCfgs above, so Add Data + activateStaticLayer
  // can re-create them on demand; saved maps re-create any they used (restore block).
  catalog.layers = catalog.layers.filter(l => !(l.category === 'sites' && l.geometry === 'point'));

  // Merge dataset categories so dynamic layers get a category tag in the panel.
  getCategories().forEach(c => {
    state.catIdByLabel[c.label] = c.id;
    if (!catalog.categories.some(x => x.id === c.id)) catalog.categories.push(c);
  });

  // Seed active layers + order from the (static) catalog defaults.
  catalog.layers.forEach(l => { if (l.visible) state.activeLayerIds.add(l.id); });
  state.layerOrder = catalog.layers.map(l => l.id);

  // A shareable permalink (#m=...) takes precedence over the saved active map;
  // otherwise restore the currently-active saved map (from the Saved Maps list).
  // If there's no active map, fall back to the most-recently-saved one so a plain
  // refresh restores your last work — unless you explicitly chose "New Map".
  let freshMap = false;
  try { freshMap = sessionStorage.getItem('savi.newMap') === '1'; sessionStorage.removeItem('savi.newMap'); } catch { /* ignore */ }
  const permalink = readPermalink();
  let activeId = permalink ? null : getActiveMapId();
  if (!permalink && !activeId && !freshMap) {
    const recent = listSavedMaps()[0];   // listSavedMaps() is most-recent-first
    if (recent) { activeId = recent.id; setActiveMapId(recent.id); }
  }
  const activeEntry = activeId ? getSavedMap(activeId) : null;
  const saved = permalink || (activeEntry ? activeEntry.state : null);
  if (saved) {
    if (!permalink) state.activeMapId = activeId;
    // Recreate saved dynamic indicator layers before applying order/active/styles.
    for (const d of (saved.dynamic || [])) {
      const cfg = await createIndicatorCfg(d.indicatorId, d.sel, d, d.id);
      if (cfg) { catalog.layers.push(cfg); if (state.dynSeq < seqOf(d.id)) state.dynSeq = seqOf(d.id); }
    }
    // Recreate named "Places" (pin) layers from saved coordinates. Because each
    // id is then present in saved.order/active, applySavedToCatalog + the load
    // loop slot them in, add them, and bindPopups registers their popups.
    // Back-compat: older saves stored a single flat `pins` array.
    const savedPlaces = Array.isArray(saved.places)
      ? saved.places
      : (saved.pins && saved.pins.length
          ? [{ id: 'places_1', label: 'My Places', points: saved.pins }]
          : []);
    for (const pl of savedPlaces) {
      const features = (pl.points || []).map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          name: p.name,
          pid: p.pid || newPinId(),
          meta: Array.isArray(p.meta) ? p.meta : []
        }
      }));
      const id = pl.id || ('places_' + (state.placesSeq + 1));
      catalog.layers.push(makePinsCfg(id, pl.label || 'My Places', features));
      if (state.placesSeq < placesSeqOf(id)) state.placesSeq = placesSeqOf(id);
    }
    // Recreate dynamic boundary overlays (not the static 'counties' layer, which is
    // restored through the normal static-catalog path).
    for (const b of (saved.boundaries || [])) {
      const t = boundaryType(b.key);
      if (!t || t.staticId) continue;
      const cfg = createBoundaryCfg(t);
      if (b.opacity != null) cfg.opacity = b.opacity;
      if (b.paint) cfg.paint = b.paint;
      catalog.layers.push(cfg);
    }
    // Recreate imported (GeoJSON/KML) layers from their inline feature collections,
    // preserving any restyled paint/opacity.
    for (const im of (saved.imported || [])) {
      const features = (im.sourceData && im.sourceData.features) || [];
      const id = im.id || ('imported_' + (state.importedSeq + 1));
      const cfg = makeImportedCfg(id, im.label || 'Imported data', im.geometry, features, null, im.paint);
      if (im.opacity != null) cfg.opacity = im.opacity;
      catalog.layers.push(cfg);
      const seq = Number((/imported_(\d+)/.exec(id) || [])[1] || 0);
      if (state.importedSeq < seq) state.importedSeq = seq;
    }
    // Re-create any Sites point layers the saved map used. They're no longer seeded
    // into the default catalog, so restore them from their pristine clones; otherwise
    // applySavedToCatalog would drop their ids (findLayer wouldn't resolve them).
    const savedLayerIds = new Set([...(saved.order || []), ...(saved.active || [])]);
    for (const id of savedLayerIds) {
      if (!findLayer(id) && defaultStaticCfgs[id] && defaultStaticCfgs[id].category === 'sites') {
        catalog.layers.push(JSON.parse(JSON.stringify(defaultStaticCfgs[id])));
      }
    }
    applySavedToCatalog(saved);
  }

  // Starting zoom for a fresh map (no saved view). On a phone the viewport is much
  // narrower, so start zoomed out a bit more to fit the whole region; desktop keeps
  // the catalog default. Used at map init and by "Reset View".
  const narrowStart = window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
  const startZoom = narrowStart
    ? Math.max(catalog.map.minZoom || 4, catalog.map.zoom - 1.5)
    : catalog.map.zoom;

  // Init map (preserveDrawingBuffer lets us read the canvas for PNG/PDF export).
  const map = new maplibregl.Map({
    container: 'map',
    style: basemapStyle(state.currentBasemap),
    center: (saved && saved.view && saved.view.center) || catalog.map.center,
    zoom: (saved && saved.view && saved.view.zoom != null) ? saved.view.zoom : startZoom,
    bearing: (saved && saved.view && saved.view.bearing != null) ? saved.view.bearing : 0,
    pitch: (saved && saved.view && saved.view.pitch != null) ? saved.view.pitch : 0,
    minZoom: catalog.map.minZoom || 4,
    maxZoom: catalog.map.maxZoom || 18,
    preserveDrawingBuffer: true,
    attributionControl: false   // we add our own below (with SAVI data credit)
  });
  state.map = map;
  window.__saviMap = map;   // debug/test hook
  window.__saviAddPin = (name, center, choice, meta) => addPin(name, center, choice, meta);   // debug/test hook
  window.__saviFlyTo = (result) => flyToLocation(result);    // debug/test hook
  window.__saviFeatured = (entry) => applyFeatured(entry);   // debug/test hook
  window.__saviImport = () => openImportPlaces({ createPlacesLayer, sampleHref: 'data/sample_places.csv' });   // debug/test hook
  window.__saviCreatePlaces = (label, points) => createPlacesLayer(label, points);   // debug/test hook
  window.__saviCreateGeojson = (label, features) => createGeojsonLayer(label, features);   // debug/test hook
  window.__saviExportData = () => exportData(orderedCfgs().filter(l => state.activeLayerIds.has(l.id)));   // debug/test hook

  const navCtrl = new maplibregl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: false });
  map.addControl(navCtrl, 'bottom-right');
  state.navCtrl = navCtrl;
  const fsCtrl = new maplibregl.FullscreenControl({ container: document.getElementById('app') });
  map.addControl(fsCtrl, 'bottom-right');
  state.fsCtrl = fsCtrl;
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserLocation: true
  });
  map.addControl(geolocate, 'bottom-right');
  state.geolocate = geolocate;   // let the toolbar trigger the live location dot
  const scaleCtrl = new maplibregl.ScaleControl({ maxWidth: 120, unit: 'imperial' });
  map.addControl(scaleCtrl, 'bottom-right');
  state.scaleCtrl = scaleCtrl;

  // Mobile-only: it's easy to accidentally zoom in on a phone and lose your place.
  // Disable double-tap zoom (the usual culprit) and add a one-tap "Recenter" button
  // that flies back to the regional starting view. Desktop is unaffected.
  if (narrowStart) {
    try { map.doubleClickZoom.disable(); } catch { /* ignore */ }
    const recenter = {
      onAdd(m) {
        this._map = m;
        const div = document.createElement('div');
        div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = 'Recenter the map';
        btn.setAttribute('aria-label', 'Recenter the map');
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>';
        btn.addEventListener('click', () => {
          m.flyTo({ center: catalog.map.center, zoom: startZoom, bearing: 0, pitch: 0, duration: 700 });
        });
        div.appendChild(btn);
        this._container = div;
        return div;
      },
      onRemove() { if (this._container) this._container.remove(); this._map = undefined; }
    };
    map.addControl(recenter, 'bottom-right');
  }
  // Apply saved show/hide prefs for the map controls (all default ON).
  applyControlVisibility();
  // Persistent data-source credit to SAVI (indicator values are shared by SAVI).
  map.addControl(new maplibregl.AttributionControl({
    compact: false,
    customAttribution: 'Data shared by <a href="https://classic.savi.org/savi" target="_blank" rel="noopener">SAVI</a> (Polis Center at IU Indianapolis)'
  }), 'bottom-left');

  map.on('load', async () => {
    // Add each layer per its default visibility
    for (const layerCfg of catalog.layers) {
      await addLayer(map, layerCfg, state.activeLayerIds.has(layerCfg.id));
    }
    ensure3DBuildings();   // restore the 3D-buildings overlay (under data layers) if saved on
    applyLayerOrder(map, orderedCfgs());
    bindPopups(map, catalog.layers, { onEnrich: buildTrendSparkline, actions: compareActions, onPinClick: openPinEditor });
    refreshLegend();
    // Re-apply restored transient UI so a reopened map looks exactly as it was saved.
    if (state.compareSet.length) refreshCompareHighlight();
    if (saved && saved.legendHighlight) {
      const hl = saved.legendHighlight;
      // Back-compat: older saves stored a single `index`; new ones store `indices`.
      const indices = Array.isArray(hl.indices) ? hl.indices : (hl.index != null ? [hl.index] : []);
      const cfg = findLayer(hl.layerId);
      if (cfg && cfg.choropleth && indices.length) { applyLegendHighlight(cfg, indices); refreshLegend(); }
    }
    // Panning/zooming changes the saved view — flag unsaved changes on user moves.
    map.on('moveend', (e) => { if (!e.savi_programmatic) markDirty(); });
  });

  // ---- UI wiring ----
  buildBasemapSwitcher(BASEMAPS, state.currentBasemap, switchBasemap,
    { getBuildings3d: () => state.buildings3d, onToggle3D: set3DBuildings });

  // Top toolbar: panel toggles, save-to-device, export.
  buildToolbar({
    panels: [
      // group: 'panel' = floating panels, 'tool' = compare modes, 'control' = map controls.
      { key: 'basemap', label: 'Basemap', group: 'panel', el: document.getElementById('panel-basemap'),
        onToggle: () => { document.getElementById('panel-basemap').classList.toggle('hidden'); markDirtyNow(); } },
      { key: 'layers', label: 'Layers', group: 'panel', el: document.getElementById('panel-layers'),
        onToggle: () => { document.getElementById('panel-layers').classList.toggle('hidden'); markDirtyNow(); } },
      { key: 'legend', label: 'Legend', group: 'panel', el: document.getElementById('panel-legend'),
        onToggle: () => { document.getElementById('panel-legend').classList.toggle('hidden'); markDirtyNow(); } },
      { key: 'timeline', label: 'Timeline', group: 'panel', el: document.getElementById('panel-timeline'),
        onToggle: () => {
          const tl = document.getElementById('panel-timeline');
          const willHide = !tl.classList.contains('hidden');
          tl.classList.toggle('hidden');
          if (willHide) stopPlay();   // closing the timeline stops any running animation
          state.timelineTouched = true;
          markDirtyNow();
        } },
      { key: 'help', label: 'Help', group: 'panel', el: document.getElementById('panel-help'),
        onToggle: () => {
          const h = document.getElementById('panel-help');
          if (h.classList.contains('hidden')) openHelpPanel();   // show + build + focus
          else h.classList.add('hidden');
          markDirtyNow();
        } },
      { key: 'swipe', label: 'Swipe compare', group: 'tool',
        isOn: () => isSwipeOpen(),
        onToggle: () => openSwipeCompare() },
      { key: 'zoom', label: 'Zoom controls', group: 'control',
        isOn: () => controlPref('zoom'),
        onToggle: () => { const on = !controlPref('zoom'); setControlPref('zoom', on); applyControlVisibility(); markDirty(); } },
      { key: 'fullscreen', label: 'Fullscreen button', group: 'control',
        isOn: () => controlPref('fullscreen'),
        onToggle: () => { const on = !controlPref('fullscreen'); setControlPref('fullscreen', on); applyControlVisibility(); markDirty(); } },
      { key: 'locate', label: 'Locate button', group: 'control',
        isOn: () => controlPref('locate'),
        onToggle: () => { const on = !controlPref('locate'); setControlPref('locate', on); applyControlVisibility(); markDirty(); } },
      { key: 'scale', label: 'Distance scale', group: 'control',
        isOn: () => controlPref('scale'),
        onToggle: () => { const on = !controlPref('scale'); setControlPref('scale', on); applyControlVisibility(); markDirty(); } }
    ],
    onAddData: () => openAddData(),
    onSave: () => {
      const active = state.activeMapId ? getSavedMap(state.activeMapId) : null;
      const suggestion = suggestSaveMeta();
      openSaveMapDialog({
        name: active ? active.name : '',
        description: active ? active.description : '',
        suggestedName: suggestion.name,
        suggestedDescription: suggestion.description,
        isEditing: !!active,
        onSave: ({ name, description, asNew }) => {
          const id = (active && !asNew) ? active.id : null;
          const savedId = saveNamedMap({ id, name, description, state: captureMapState() });
          state.activeMapId = savedId;
          setActiveMapId(savedId);
          setSaveDirty(false);
          showToast(`${(active && !asNew) ? 'Updated' : 'Saved'} \u201c${name}\u201d.`);
        }
      });
    },
    onOpenSavedMaps: () => {
      openSavedMapsDialog({
        getMaps: () => listSavedMaps(),
        activeId: state.activeMapId,
        onOpen: (id) => { setActiveMapId(id); location.reload(); },
        onDelete: (id) => {
          deleteSavedMap(id);
          if (state.activeMapId === id) { clearActiveMapId(); state.activeMapId = null; }
        }
      });
    },
    onNewMap: () => {
      // Stop autosave first: otherwise the debounced timer or the pagehide flush
      // fires during the reload and re-creates an active autosave map from the
      // CURRENT layers (ensureAutosaveMap), which init() then restores — so the
      // "new" map would come back with all the old data layers.
      state.autosave = false;
      if (state.autosaveTimer) { clearTimeout(state.autosaveTimer); state.autosaveTimer = null; }
      clearActiveMapId();
      state.activeMapId = null;
      // Strip any shareable permalink (#m=...) from the URL. A permalink in the hash
      // survives location.reload() and takes precedence over the fresh-map flag in
      // init(), so without this the "new" map would restore the shared/old layers.
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
      // Signal init() to skip the "restore last saved map" fallback on this reload.
      try { sessionStorage.setItem('savi.newMap', '1'); } catch { /* ignore */ }
      showToast('Starting a new map\u2026');
      setTimeout(() => location.reload(), 500);
    },
    onCopyLink: () => copyPermalink(),
    onShare: () => shareCurrentView(),
    onResetLayout: () => {
      resetPanelLayout();
      markDirty();
      showToast('Panels reset to default layout.');
    },
    onExportImage: () => exportImage(state.map),
    onExportPdf: () => exportPdf(state.map, {
      title: 'Community Data Map',
      legendHtml: document.getElementById('legend').innerHTML
    }),
    onExportData: () => exportData(orderedCfgs().filter(l => state.activeLayerIds.has(l.id))),
    onExportCsv: () => exportIndicatorsCsv(),
    onOpenTable: () => openTableModal({
      getGeo,
      // Seed Compare columns from the indicator layers currently visible on the map.
      getVisibleColumns: () => orderedCfgs()
        .filter(l => state.activeLayerIds.has(l.id) && l.kind === 'indicator' && l.indicatorId)
        .map(l => ({ indicatorId: l.indicatorId, level: l.level, display: l.display, year: l.year })),
      // The click-to-compare selection, for the table's "Selected only" row filter.
      getCompareGeos: () => state.compareSet.map(g => ({ level: g.level, id: g.id }))
    }),
    onOpenProfile: () => openProfileModal({ getGeo }),
    onOpenFeatured: () => openFeaturedGallery({ apply: applyFeatured }),
    onImportPlaces: () => openImportPlaces({ createPlacesLayer, sampleHref: 'data/sample_places.csv' }),
    onImportGeojson: () => openImportGeojson({ createGeojsonLayer }),
    onOpenHelp: () => openHelpPanel(),
    onOpenWelcome: () => openWelcomeCard({
      onBrowseFeatured: () => openFeaturedGallery({ apply: applyFeatured }),
      onAddData: () => openAddData()
    }),
    onResetView: () => {
      if (!state.map) return;
      state.map.flyTo({
        center: catalog.map.center, zoom: startZoom,
        bearing: 0, pitch: 0, duration: 900
      });
      showToast('View reset to the starting extent.');
    },
    onFlyTo: (result) => flyToLocation(result),
    onSearchGeos: (q) => searchGeographies(q),
    onPickGeo: (geo) => highlightGeography(geo),
    onLocate: () => { if (state.geolocate) try { state.geolocate.trigger(); } catch { /* not ready */ } },
    getAutosave: () => state.autosave,
    onToggleAutosave: () => {
      state.autosave = !state.autosave;
      try { localStorage.setItem('savi.autosave', state.autosave ? '1' : '0'); } catch { /* ignore */ }
      if (state.autosave) {
        ensureAutosaveMap();   // create a saved map now so autosave has a target
        setSaveDirty(false);
        showToast('Autosave on \u2014 changes save automatically.');
      } else {
        showToast('Autosave off.');
      }
    }
  });

  layerHandlers = {
    order: state.layerOrder,
    activeLayerIds: state.activeLayerIds,
    onToggle: (layerId, on) => {
      if (on) state.activeLayerIds.add(layerId);
      else state.activeLayerIds.delete(layerId);
      updateLayerVisibility(state.map, findLayer(layerId), on);
      refreshLegend();
      refreshTimeSlider();
      markDirty();
    },
    onOpacity: (layerId, value) => {
      updateLayerOpacity(state.map, findLayer(layerId), value);
      markDirty();
    },
    onReorder: (newOrderIds) => {
      state.layerOrder = newOrderIds;
      layerHandlers.order = state.layerOrder;
      applyLayerOrder(state.map, orderedCfgs());
      refreshLegend();
      markDirty();
    },
    onColor: (layerId, color) => {
      setLayerColor(state.map, findLayer(layerId), color);
      refreshLegend();
      markDirty();
    },
    onPattern: (layerId, kind) => {
      setLayerPattern(state.map, findLayer(layerId), kind);
      applyLayerOrder(state.map, orderedCfgs());
      refreshLegend();
      markDirty();
    },
    onPatternOpacity: (layerId, value) => {
      setLayerPatternOpacity(state.map, findLayer(layerId), value);
      markDirty();
    },
    onRamp: (layerId, rampName) => {
      setLayerRamp(state.map, findLayer(layerId), rampName);
      refreshLegend();
      markDirty();
    },
    onClassify: (layerId, classify) => {
      const cfg = findLayer(layerId);
      if (!cfg) return;
      cfg.classify = { ...(cfg.classify || {}), ...classify };
      reclassify(state.map, cfg);
      rebuildPanel();
      refreshLegend();
      markDirty();
    },
    onSelect: async (layerId, sel) => { await selectIndicator(layerId, sel); refreshTimeSlider(); },
    onBulkEditPins: (layerId) => openBulkPinEditor(findLayer(layerId)),
    onDownloadLayer: (layerId, format) => exportLayer(findLayer(layerId), format),
    onDelete: (layerId) => deleteLayer(layerId),
    onRename: (layerId, label) => {
      const cfg = findLayer(layerId);
      if (!cfg || !label || label === cfg.label) return;
      cfg.label = label;
      rebuildPanel();
      refreshLegend();
      markDirty();
    }
  };
  rebuildPanel();
  refreshTimeSlider();

  // "+" opens the indicator catalog modal.
  const addBtn = document.getElementById('add-data-btn');
  if (addBtn) addBtn.addEventListener('click', () => openAddData());

  // Single Clear button in the Layers panel header opens a modal that asks whether
  // to clear all layers or just the hidden ones.
  const clearBtn = document.getElementById('clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => openClearDialog());

  // Footer Help button opens the searchable knowledge base.
  const helpBtn = document.getElementById('help-btn');
  if (helpBtn) helpBtn.addEventListener('click', () => openHelpPanel());

  // ---- Floating panels: draggable + collapsible + a close (X) on the far right ----
  document.querySelectorAll('.float-panel').forEach(panel => {
    const handle = panel.querySelector('.float-panel-header');
    const collapseBtn = panel.querySelector('.collapse-btn');
    if (handle) makeDraggable(panel, handle, () => markDirty());
    if (collapseBtn) makeCollapsible(panel, collapseBtn, () => markDirty());
    // The Layers and Legend panels are the tall, content-heavy ones — let users
    // resize them from a bottom-right grip.
    if (panel.id === 'panel-layers' || panel.id === 'panel-legend' || panel.id === 'panel-help') {
      makeResizable(panel, () => markDirty());
    }

    // Hide the panel from its own header; the View menu re-checks state on open,
    // so it can be brought back from there.
    if (handle && !handle.querySelector('.panel-close-btn')) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'panel-close-btn';
      const title = (panel.querySelector('.float-panel-title') || {}).textContent || 'panel';
      close.setAttribute('aria-label', `Close ${title}`);
      close.title = `Close ${title}`;
      close.textContent = '\u00d7';
      close.addEventListener('click', () => {
        panel.classList.add('hidden');
        if (panel.id === 'panel-timeline') { state.timelineTouched = true; stopPlay(); }
        markDirtyNow();
      });
      handle.appendChild(close);
    }
  });

  // Restore saved control visibility + floating-panel layout (defaults if none saved).
  applySavedUiState(saved);

  // Keep --toolbar-h synced with the toolbar's real height so the docks always
  // clear it (on narrow screens the button row wraps to 2–3 rows).
  syncToolbarHeight();

  // On a phone with no explicit saved layout, start the panels collapsed so the
  // map is the hero; each panel is one tap away from its title bar. Desktop and
  // any restored saved map are untouched.
  if (!(saved && Array.isArray(saved.panels)) &&
      window.matchMedia && window.matchMedia('(max-width: 720px)').matches) {
    ['panel-basemap', 'panel-layers', 'panel-legend'].forEach(collapsePanelById);
  }

  // First-run welcome card (one-time; re-openable from Help). Gated by a flag so it
  // only auto-shows once per browser.
  let welcomed = true;
  try { welcomed = localStorage.getItem('savi.welcomed') === '1'; } catch { /* ignore */ }
  if (!welcomed) {
    openWelcomeCard({
      onBrowseFeatured: () => openFeaturedGallery({ apply: applyFeatured }),
      onAddData: () => openAddData()
    });
  }
}

// Catalog configs in current panel/draw order (index 0 = top).
function orderedCfgs() {
  return state.layerOrder.map(id => findLayer(id)).filter(Boolean);
}

// Placeholder name + description derived from the layers currently shown, offered as
// editable defaults in the Save Map dialog (the user can override or accept them).
function suggestSaveMeta() {
  const active = orderedCfgs().filter(l => state.activeLayerIds.has(l.id));
  if (!active.length) return { name: '', description: '' };
  const labels = active.map(l => l.label || l.id);
  let name;
  if (labels.length === 1) name = labels[0];
  else if (labels.length === 2) name = `${labels[0]} & ${labels[1]}`;
  else name = `${labels[0]}, ${labels[1]} +${labels.length - 2} more`;
  if (name.length > 80) name = name.slice(0, 77) + '\u2026';
  const lines = active.map(l => {
    const ctx = [l.level, l.display, l.year].filter(v => v != null && v !== '').join(' \u00b7 ');
    return ctx ? `${l.label || l.id} \u2014 ${ctx}` : (l.label || l.id);
  });
  let description = (active.length === 1 ? 'Showing: ' : `${active.length} layers: `) + lines.join('; ');
  if (description.length > 400) description = description.slice(0, 397) + '\u2026';
  return { name, description };
}

// ---- "Places" pin layers ----
// Users can drop named pins into one or more named "Places" layers (default
// "My Places", then "My Places 1", ...). Each is a normal point catalog layer
// whose data lives inline in cfg.sourceData, so it saves/restores with the map.
// Each pin feature carries a stable `pid`, its `name`, and a `meta` array of
// { type, value } custom-metadata pairs.
function makePinsCfg(id, label, features) {
  return {
    id,
    label,
    category: 'My Places',
    kind: 'pins',
    geometry: 'point',
    sourceData: { type: 'FeatureCollection', features: features || [] },
    opacity: 1,
    paint: {
      'circle-color': '#d4af37',
      'circle-radius': 7,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#1b1b1b'
    },
    legend: [{ label: 'Saved place', color: '#d4af37' }],
    popup: { title: 'name', fields: [] }
  };
}

// Every Places (pin) layer currently on the map.
function placesLayers() {
  return state.catalog.layers.filter(l => l.kind === 'pins');
}
// Find a Places layer by its (case-insensitive) label.
function placesLayerByLabel(label) {
  const t = String(label || '').trim().toLowerCase();
  return placesLayers().find(l => String(l.label).trim().toLowerCase() === t);
}
// A smart default name for a NEW Places layer: "My Places", then "My Places 1"...
function defaultPlacesLabel() {
  const base = 'My Places';
  if (!placesLayerByLabel(base)) return base;
  let n = 1;
  while (placesLayerByLabel(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
// Numeric suffix of a places id ("places_3" -> 3) for seq bookkeeping.
function placesSeqOf(id) {
  const m = /places_(\d+)/.exec(id || '');
  return m ? Number(m[1]) : 0;
}
function newPinId() {
  return 'pin_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Create a new Places layer from a batch of imported points (name + lng/lat +
// optional meta key/value pairs). Adds the layer, binds popups, fits the map to
// the points, and returns how many were placed. Used by the CSV importer.
async function createPlacesLayer(label, points) {
  if (!Array.isArray(points) || !points.length) return 0;
  const features = points.map(p => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: { name: p.name || 'Place', pid: newPinId(), meta: Array.isArray(p.meta) ? p.meta : [] }
  }));
  const id = 'places_' + (++state.placesSeq);
  const cfg = makePinsCfg(id, (label && label.trim()) || defaultPlacesLabel(), features);
  state.catalog.layers.push(cfg);
  state.layerOrder.unshift(cfg.id);
  state.activeLayerIds.add(cfg.id);
  await addLayer(state.map, cfg, true);
  bindPopups(state.map, [cfg]);
  applyLayerOrder(state.map, orderedCfgs());
  rebuildPanel();
  refreshLegend();
  // Frame the imported points.
  const bounds = new maplibregl.LngLatBounds();
  features.forEach(f => bounds.extend(f.geometry.coordinates));
  try { state.map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 900 }); } catch { /* single point / bad bounds */ }
  markDirty();
  return features.length;
}

// ---- Imported (GeoJSON / KML) layers ----
// Users import their own GeoJSON or KML as regular layers. Features are grouped by
// geometry family (points / lines / areas) into one catalog layer each, with the
// data held inline in cfg.sourceData so it saves/restores with the map.
const IMPORT_PALETTE = ['#2b8cbe', '#e6550d', '#31a354', '#756bb1', '#d62728', '#17becf'];

// Which of our three render families a GeoJSON geometry type belongs to.
function geomFamily(type) {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'LineString' || type === 'MultiLineString') return 'line';
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon';
  return null;
}

// Build a popup config from the properties present on imported features: pick a
// title-ish key (name/title/label/id, case-insensitive) and expose the rest as
// fields (capped so a huge property set doesn't overflow the window).
function importedPopup(features) {
  const keys = [];
  const seen = new Set();
  (features || []).slice(0, 50).forEach(f => {
    const props = (f && f.properties) || {};
    Object.keys(props).forEach(k => { if (!seen.has(k)) { seen.add(k); keys.push(k); } });
  });
  const titleKey = keys.find(k => /^(name|title|label|id)$/i.test(k)) || keys[0] || null;
  const fields = keys.filter(k => k !== titleKey).slice(0, 12).map(k => ({ key: k, label: k }));
  return { title: titleKey, fields };
}

// Default style + popup for an imported layer of a given geometry family.
function makeImportedCfg(id, label, geometry, features, color, paint) {
  const defaultPaint = geometry === 'point'
    ? { 'circle-color': color, 'circle-radius': 6, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' }
    : geometry === 'line'
      ? { 'line-color': color, 'line-width': 3 }
      : { 'fill-color': color, 'fill-opacity': 0.4, 'line-color': color, 'line-width': 1.5 };
  return {
    id, label,
    category: 'Imported data',
    kind: 'imported',
    geometry,
    sourceData: { type: 'FeatureCollection', features: features || [] },
    opacity: 1,
    paint: paint || defaultPaint,
    legend: [{ label, color }],
    popup: importedPopup(features)
  };
}

// Extend a LngLatBounds by every coordinate in a GeoJSON geometry (any type).
function extendBounds(bounds, geom) {
  if (!geom) return;
  const walk = (c) => {
    if (typeof c[0] === 'number') { bounds.extend(c); return; }
    c.forEach(walk);
  };
  if (geom.type === 'GeometryCollection') (geom.geometries || []).forEach(g => extendBounds(bounds, g));
  else if (geom.coordinates) walk(geom.coordinates);
}

// All imported (GeoJSON/KML) layers currently on the map.
function importedLayers() {
  return state.catalog.layers.filter(l => l.kind === 'imported');
}

// Create one or more imported layers from a flat array of GeoJSON features (from
// the GeoJSON/KML importer). Groups by geometry family, adds each layer, binds
// popups, fits the map to everything, and returns { features, layers } counts.
async function createGeojsonLayer(label, features) {
  const groups = { point: [], line: [], polygon: [] };
  (features || []).forEach(f => {
    const fam = geomFamily(f && f.geometry && f.geometry.type);
    if (fam) groups[fam].push(f);
  });
  const fams = ['point', 'line', 'polygon'].filter(k => groups[k].length);
  if (!fams.length) return { features: 0, layers: 0 };

  const base = (label && label.trim()) || 'Imported data';
  const famLabel = { point: 'points', line: 'lines', polygon: 'areas' };
  const cfgs = [];
  fams.forEach((fam) => {
    const id = 'imported_' + (++state.importedSeq);
    const lbl = fams.length > 1 ? `${base} (${famLabel[fam]})` : base;
    const color = IMPORT_PALETTE[(state.importedSeq - 1) % IMPORT_PALETTE.length];
    const cfg = makeImportedCfg(id, lbl, fam, groups[fam], color);
    state.catalog.layers.push(cfg);
    state.layerOrder.unshift(cfg.id);
    state.activeLayerIds.add(cfg.id);
    cfgs.push(cfg);
  });

  for (const cfg of cfgs) await addLayer(state.map, cfg, true);
  bindPopups(state.map, cfgs);
  applyLayerOrder(state.map, orderedCfgs());
  rebuildPanel();
  refreshLegend();

  const bounds = new maplibregl.LngLatBounds();
  cfgs.forEach(cfg => cfg.sourceData.features.forEach(f => extendBounds(bounds, f.geometry)));
  try { state.map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 900 }); } catch { /* bad bounds */ }
  markDirty();
  const total = fams.reduce((n, k) => n + groups[k].length, 0);
  return { features: total, layers: cfgs.length };
}

// Drop a named pin at center. `choice` selects the target Places layer:
//   { id }        -> append to an existing layer by id
//   { newLabel }  -> create (or reuse by name) a layer with that label
// `meta` is an optional array of { type, value } custom-metadata pairs.
async function addPin(name, center, choice, meta) {
  const feat = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: center },
    properties: { name, pid: newPinId(), meta: Array.isArray(meta) ? meta : [] }
  };

  // Resolve the target layer (existing by id, existing by name, or brand new).
  let cfg = (choice && choice.id) ? findLayer(choice.id) : null;
  if (!cfg && choice && choice.newLabel) cfg = placesLayerByLabel(choice.newLabel);

  if (!cfg) {
    const label = (choice && choice.newLabel && choice.newLabel.trim()) || defaultPlacesLabel();
    const id = 'places_' + (++state.placesSeq);
    cfg = makePinsCfg(id, label, [feat]);
    state.catalog.layers.push(cfg);
    state.layerOrder.unshift(cfg.id);      // new layer starts on top
    state.activeLayerIds.add(cfg.id);
    await addLayer(state.map, cfg, true);
    bindPopups(state.map, [cfg]);
    applyLayerOrder(state.map, orderedCfgs());
    rebuildPanel();
  } else {
    cfg.sourceData.features.push(feat);
    const src = state.map.getSource('src-' + cfg.id);
    if (src) src.setData(cfg.sourceData);
    state.activeLayerIds.add(cfg.id);
    updateLayerVisibility(state.map, cfg, true);
    rebuildPanel();
  }
  refreshLegend();
  markDirty();
  if (state.searchMarker) { state.searchMarker.remove(); }   // clear the transient blue marker
  showToast(`Pinned: ${name} \u2192 ${cfg.label}`);
}

// Fly to a geocoded/geolocated result and drop a single reusable marker there.
// The marker's popup offers a pin name, a Places-layer chooser (existing layer
// or a new named one), and a "Save as pin" button that promotes it into a
// persistent Places layer.
function flyToLocation({ center, bbox, zoom, label }) {
  const map = state.map;
  if (!map || !center) return;
  if (bbox && bbox.length === 4) {
    // Nominatim bbox = [south, north, west, east] -> LngLatBounds([w,s],[e,n]).
    const [s, n, w, e] = bbox;
    map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 15, duration: 900 });
  } else {
    map.flyTo({ center, zoom: zoom != null ? zoom : 13, duration: 900 });
  }
  if (!state.searchMarker) {
    state.searchMarker = new maplibregl.Marker({ color: '#1a6ec2' });
  }
  state.searchMarker.setLngLat(center);

  const shortLabel = label ? String(label).split(',')[0] : 'Pinned place';
  const pop = new maplibregl.Popup({ offset: 24, maxWidth: '280px' });
  const box = document.createElement('div');
  box.className = 'savi-pin-pop';
  if (label) {
    const cap = document.createElement('div');
    cap.className = 'savi-pin-label';
    cap.textContent = label;
    box.appendChild(cap);
  }

  // Pin name.
  box.appendChild(pinFieldLabel('Name'));
  const nameInput = document.createElement('input');
  nameInput.className = 'savi-pin-input';
  nameInput.type = 'text';
  nameInput.value = shortLabel;
  nameInput.setAttribute('aria-label', 'Pin name');
  box.appendChild(nameInput);

  // Target Places layer: choose an existing one or create a new named layer.
  const existing = placesLayers();
  box.appendChild(pinFieldLabel('Layer'));
  const layerSel = document.createElement('select');
  layerSel.className = 'savi-pin-input savi-pin-layer';
  layerSel.setAttribute('aria-label', 'Places layer');
  existing.forEach(l => {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.label;
    layerSel.appendChild(o);
  });
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = existing.length ? '\uff0b New layer\u2026' : 'New layer\u2026';
  layerSel.appendChild(newOpt);
  // Default: append to the most recent existing layer, else a fresh named layer.
  layerSel.value = existing.length ? existing[0].id : '__new__';
  box.appendChild(layerSel);

  const newNameInput = document.createElement('input');
  newNameInput.className = 'savi-pin-input savi-pin-newlayer';
  newNameInput.type = 'text';
  newNameInput.value = defaultPlacesLabel();
  newNameInput.setAttribute('aria-label', 'New layer name');
  newNameInput.placeholder = 'New layer name';
  box.appendChild(newNameInput);

  const syncNewVisibility = () => {
    newNameInput.style.display = layerSel.value === '__new__' ? '' : 'none';
  };
  syncNewVisibility();
  layerSel.addEventListener('change', syncNewVisibility);

  const btn = document.createElement('button');
  btn.className = 'savi-pin-save';
  btn.type = 'button';
  btn.textContent = 'Save as pin';
  btn.addEventListener('click', () => {
    const choice = layerSel.value === '__new__'
      ? { newLabel: newNameInput.value.trim() || defaultPlacesLabel() }
      : { id: layerSel.value };
    addPin(nameInput.value.trim() || shortLabel, center, choice);
    pop.remove();
  });
  box.appendChild(btn);
  pop.setDOMContent(box);
  state.searchMarker.setPopup(pop);
  state.searchMarker.addTo(map);
}

// A small caption above a pin-popup field.
function pinFieldLabel(text) {
  const el = document.createElement('div');
  el.className = 'savi-pin-field-label';
  el.textContent = text;
  return el;
}

// ---- Editable pin window (opened by clicking a pin) ----
// Shows the pin's name + custom type/value metadata, lets the user edit/add/
// remove pairs, and save or delete the pin. Updates persist in saved maps.
function openPinEditor(cfg, props, lngLat) {
  const map = state.map;
  const feat = cfg.sourceData.features.find(f => f.properties.pid === props.pid);
  if (!feat) return;

  const pop = new maplibregl.Popup({ offset: 24, maxWidth: '300px', className: 'savi-pin-editor-pop' })
    .setLngLat(lngLat);
  const box = document.createElement('div');
  box.className = 'savi-pin-pop savi-pin-editor';
  pop.setDOMContent(box);
  pop.addTo(map);

  const metaOf = () => (Array.isArray(feat.properties.meta) ? feat.properties.meta : parseMeta(feat.properties.meta));

  // ---- Read-only view: data shown as plain rows + an Edit button ----
  function renderView() {
    box.textContent = '';
    const head = document.createElement('div');
    head.className = 'savi-pin-label';
    head.textContent = cfg.label;
    box.appendChild(head);

    const name = document.createElement('div');
    name.className = 'savi-pin-view-name';
    name.textContent = feat.properties.name || 'Saved place';
    box.appendChild(name);

    const meta = metaOf();
    if (meta.length) {
      const dl = document.createElement('dl');
      dl.className = 'savi-pin-view-data';
      meta.forEach(m => {
        const dt = document.createElement('dt');
        dt.textContent = m.type || '';
        const dd = document.createElement('dd');
        dd.textContent = m.value || '';
        dl.append(dt, dd);
      });
      box.appendChild(dl);
    } else {
      const empty = document.createElement('div');
      empty.className = 'savi-pin-view-empty';
      empty.textContent = 'No custom data yet.';
      box.appendChild(empty);
    }

    const actions = document.createElement('div');
    actions.className = 'savi-pin-editor-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'savi-pin-save';
    edit.textContent = 'Edit';
    edit.addEventListener('click', renderEdit);
    actions.appendChild(edit);
    box.appendChild(actions);
  }

  // ---- Edit view: name input + add/remove data rows + Save/Delete ----
  function renderEdit() {
    box.textContent = '';
    const head = document.createElement('div');
    head.className = 'savi-pin-label';
    head.textContent = cfg.label;
    box.appendChild(head);

    box.appendChild(pinFieldLabel('Name'));
    const nameInput = document.createElement('input');
    nameInput.className = 'savi-pin-input';
    nameInput.type = 'text';
    nameInput.value = feat.properties.name || '';
    nameInput.setAttribute('aria-label', 'Pin name');
    box.appendChild(nameInput);

    box.appendChild(pinFieldLabel('Custom data'));
    const editor = buildMetaRowsEditor(metaOf());
    box.appendChild(editor.rows);
    box.appendChild(editor.addBtn);

    const actions = document.createElement('div');
    actions.className = 'savi-pin-editor-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'savi-pin-save';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      feat.properties.name = nameInput.value.trim() || feat.properties.name || 'Saved place';
      feat.properties.meta = editor.collect();
      const src = map.getSource('src-' + cfg.id);
      if (src) src.setData(cfg.sourceData);
      markDirty();
      showToast('Saved: ' + feat.properties.name);
      renderView();   // back to read-only, showing the updated data
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'savi-pin-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', renderView);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'savi-pin-delete';
    del.textContent = 'Delete pin';
    del.addEventListener('click', () => {
      cfg.sourceData.features = cfg.sourceData.features.filter(f => f.properties.pid !== props.pid);
      if (!cfg.sourceData.features.length) {
        deleteLayer(cfg.id);   // last pin gone -> remove the whole (empty) layer
      } else {
        const src = map.getSource('src-' + cfg.id);
        if (src) src.setData(cfg.sourceData);
        markDirty();
      }
      pop.remove();
      showToast('Pin deleted.');
    });
    actions.append(save, cancel, del);
    box.appendChild(actions);
  }

  renderView();
}

// Parse a pin's meta property, which MapLibre returns as a JSON string from
// queryRenderedFeatures (arrays/objects are serialized). Returns [] on failure.
function parseMeta(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  return [];
}

// Build a reusable key/value ("type"/"value") rows editor, shared by the single-
// pin and bulk-pin editors. Returns { rows, addBtn, collect } where collect() ->
// [{type,value}] with fully-blank rows dropped.
function buildMetaRowsEditor(initialMeta) {
  const rows = document.createElement('div');
  rows.className = 'savi-pin-meta-rows';
  const addRow = (type, value) => {
    const row = document.createElement('div');
    row.className = 'savi-pin-meta-row';
    const k = document.createElement('input');
    k.className = 'savi-pin-input savi-pin-meta-k';
    k.type = 'text'; k.placeholder = 'Type'; k.value = type || '';
    k.setAttribute('aria-label', 'Field type');
    const v = document.createElement('input');
    v.className = 'savi-pin-input savi-pin-meta-v';
    v.type = 'text'; v.placeholder = 'Value'; v.value = value || '';
    v.setAttribute('aria-label', 'Field value');
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'savi-pin-meta-rm'; rm.textContent = '\u00d7';
    rm.title = 'Remove field';
    rm.addEventListener('click', () => row.remove());
    row.append(k, v, rm);
    rows.appendChild(row);
  };
  (Array.isArray(initialMeta) ? initialMeta : []).forEach(m => addRow(m.type, m.value));
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'savi-pin-meta-add';
  addBtn.textContent = '\uff0b Add field';
  addBtn.addEventListener('click', () => addRow('', ''));
  const collect = () => [...rows.querySelectorAll('.savi-pin-meta-row')]
    .map(r => ({
      type: r.querySelector('.savi-pin-meta-k').value.trim(),
      value: r.querySelector('.savi-pin-meta-v').value.trim()
    }))
    .filter(m => m.type || m.value);
  return { rows, addBtn, collect };
}

// Bulk-edit the custom key/value data for EVERY pin in a Places layer at once, so
// all places in the layer share the same fields. Pre-fills with the fields that
// are already identical across all pins. On apply, either replaces each pin's
// data with these fields or merges them in (keeping each pin's other fields).
function openBulkPinEditor(cfg) {
  if (!cfg || cfg.kind !== 'pins') return;
  const feats = (cfg.sourceData && cfg.sourceData.features) || [];
  if (!feats.length) { showToast('That layer has no places yet.'); return; }

  const metaOf = (f) => (Array.isArray(f.properties.meta) ? f.properties.meta : parseMeta(f.properties.meta));
  // Seed with fields common (same type AND value) to every pin.
  const common = metaOf(feats[0]).filter(m =>
    feats.every(f => metaOf(f).some(x => x.type === m.type && x.value === m.value)));

  const old = document.getElementById('bulkpin-overlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.className = 'cmp-overlay open';
  overlay.id = 'bulkpin-overlay';
  const modal = document.createElement('div');
  modal.className = 'cmp-modal bulkpin-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Bulk edit place data');

  const h = document.createElement('h2');
  h.className = 'bulkpin-title';
  h.textContent = 'Bulk edit \u2014 ' + cfg.label;
  modal.appendChild(h);
  const sub = document.createElement('p');
  sub.className = 'bulkpin-sub';
  sub.textContent = feats.length + ' place' + (feats.length === 1 ? '' : 's')
    + ' in this layer. Fields below apply to all of them.';
  modal.appendChild(sub);

  const editor = buildMetaRowsEditor(common);
  modal.appendChild(editor.rows);
  modal.appendChild(editor.addBtn);

  const mergeWrap = document.createElement('label');
  mergeWrap.className = 'bulkpin-merge';
  const mergeCb = document.createElement('input');
  mergeCb.type = 'checkbox';
  mergeWrap.appendChild(mergeCb);
  mergeWrap.appendChild(document.createTextNode(
    ' Keep each place\u2019s other fields (merge instead of replace)'));
  modal.appendChild(mergeWrap);

  const actions = document.createElement('div');
  actions.className = 'bulkpin-actions';
  const apply = document.createElement('button');
  apply.type = 'button'; apply.className = 'tb-btn tb-primary'; apply.textContent = 'Apply to all';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'tb-btn'; cancel.textContent = 'Cancel';
  actions.append(apply, cancel);
  modal.appendChild(actions);

  const close = () => overlay.remove();
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  apply.addEventListener('click', () => {
    const fields = editor.collect();
    feats.forEach(f => {
      if (mergeCb.checked) {
        const existing = metaOf(f).slice();
        fields.forEach(nf => {
          const i = existing.findIndex(x => x.type === nf.type);
          if (i >= 0) existing[i] = nf; else existing.push(nf);
        });
        f.properties.meta = existing;
      } else {
        f.properties.meta = fields.slice();
      }
    });
    const src = state.map.getSource('src-' + cfg.id);
    if (src) src.setData(cfg.sourceData);
    markDirty();
    close();
    showToast('Updated ' + feats.length + ' place' + (feats.length === 1 ? '' : 's') + '.');
  });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ---- Feature search & highlight (geographies) ----
// Lazily index every geography (all reporting levels) so the search box can match
// county/tract names and fly + outline them on the map.
let geoIndexPromise = null;
function buildGeoIndex() {
  if (geoIndexPromise) return geoIndexPromise;
  geoIndexPromise = (async () => {
    const index = [];
    for (const level of getLevels()) {
      let gj;
      try { gj = await getGeo(level); } catch { continue; }
      (gj.features || []).forEach(f => {
        const bbox = bboxOfGeometry(f.geometry);
        if (!bbox) return;
        index.push({
          id: f.properties.id,
          name: f.properties.name,
          level,
          bbox,                                   // [w, s, e, n]
          center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
          geometry: f.geometry
        });
      });
    }
    return index;
  })();
  return geoIndexPromise;
}

// Compute [w, s, e, n] for any GeoJSON geometry by walking its coordinates.
function bboxOfGeometry(geom) {
  if (!geom) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (a) => {
    if (typeof a[0] === 'number') {
      const [x, y] = a;
      if (x < w) w = x; if (x > e) e = x;
      if (y < s) s = y; if (y > n) n = y;
    } else a.forEach(walk);
  };
  walk(geom.coordinates || []);
  return (w === Infinity) ? null : [w, s, e, n];
}

// Synchronous name search over the (already-built) geo index. Returns [] until the
// index resolves; buildToolbar kicks off buildGeoIndex() at startup so it's ready.
let geoIndex = [];
function searchGeographies(query) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2 || !geoIndex.length) return [];
  return geoIndex
    .filter(g => String(g.name).toLowerCase().includes(q))
    .slice(0, 6);
}

// Outline + flash a geography on the map, then fly to it.
function highlightGeography(geo) {
  const map = state.map;
  if (!map || !geo) return;
  state.highlightData = { type: 'Feature', geometry: geo.geometry, properties: {} };
  ensureHighlightLayers();
  const src = map.getSource('hl-src');
  if (src) src.setData(state.highlightData);
  const [w, s, e, n] = geo.bbox;
  map.fitBounds([[w, s], [e, n]], { padding: 80, maxZoom: 12, duration: 900 });
}

// Create (once) the highlight source + fill/line layers, drawn on top of everything.
function ensureHighlightLayers() {
  const map = state.map;
  if (!map.getSource('hl-src')) {
    map.addSource('hl-src', { type: 'geojson', data: state.highlightData || { type: 'FeatureCollection', features: [] } });
  }
  if (!map.getLayer('hl-fill')) {
    map.addLayer({ id: 'hl-fill', type: 'fill', source: 'hl-src',
      paint: { 'fill-color': '#ffd400', 'fill-opacity': 0.18 } });
  }
  if (!map.getLayer('hl-line')) {
    map.addLayer({ id: 'hl-line', type: 'line', source: 'hl-src',
      paint: { 'line-color': '#ffb300', 'line-width': 3.5, 'line-opacity': 0.95 } });
  }
}

function clearHighlight() {
  state.highlightData = null;
  const map = state.map;
  if (map && map.getSource('hl-src')) map.getSource('hl-src').setData({ type: 'FeatureCollection', features: [] });
}

// ---- Click-to-compare (multi-geography selection) ----
// Clicking an indicator geography can add it to a persistent compare set. The set
// is outlined on the map and can be viewed side-by-side in the Compare table via its
// "Selected only" filter. Selection is keyed by level+id so the same-named geography
// at different reporting levels stays distinct.
const compareKey = (level, id) => `${level}|${id}`;

function isInCompare(level, id) {
  return state.compareSet.some(g => compareKey(g.level, g.id) === compareKey(level, id));
}

// Build the popup action buttons for a clicked geography. Only indicator layers (which
// have a concrete reporting level + standardized id/name props) get a compare toggle.
function compareActions(cfg, props) {
  if (cfg.kind !== 'indicator') return [];
  const resolved = resolveSelection(cfg.indicatorId, cfg.sel);
  if (!resolved) return [];
  const level = resolved.level;
  const id = props.id != null ? String(props.id) : null;
  if (id == null) return [];
  const inSet = isInCompare(level, id);
  return [
    {
      label: inSet ? '\u2713 In compare' : '+ Add to compare',
      active: inSet,
      onClick: () => toggleCompare(level, id, props.name)
    },
    {
      label: 'About the data',
      onClick: () => openMetadataModal(cfg.indicatorId)
    },
    {
      label: 'View full profile',
      onClick: () => openProfileModal({ getGeo }, { level, geoId: String(props.id) })
    }
  ];
}

function toggleCompare(level, id, name) {
  const k = compareKey(level, id);
  const i = state.compareSet.findIndex(g => compareKey(g.level, g.id) === k);
  if (i >= 0) state.compareSet.splice(i, 1);
  else state.compareSet.push({ level, id: String(id), name });
  refreshCompareHighlight();
  showToast(state.compareSet.length
    ? `${state.compareSet.length} geograph${state.compareSet.length === 1 ? 'y' : 'ies'} selected \u2014 open Compare (table), then "Selected only".`
    : 'Compare selection cleared.');
}

function clearCompareSet() {
  state.compareSet = [];
  refreshCompareHighlight();
}

// Outline every geography in the compare set. Geometries are looked up from the
// (cached) per-level geometry so we always outline the full shape, not the clipped
// rendered feature.
async function refreshCompareHighlight() {
  const map = state.map;
  if (!map) return;
  const features = [];
  const byLevel = {};
  state.compareSet.forEach(g => { (byLevel[g.level] = byLevel[g.level] || []).push(String(g.id)); });
  for (const [level, ids] of Object.entries(byLevel)) {
    let gj;
    try { gj = await getGeo(level); } catch { continue; }
    const want = new Set(ids);
    (gj.features || []).forEach(f => {
      if (want.has(String(f.properties.id))) features.push({ type: 'Feature', geometry: f.geometry, properties: {} });
    });
  }
  ensureCompareLayers();
  const src = map.getSource('cmp-src');
  if (src) src.setData({ type: 'FeatureCollection', features });
}

function ensureCompareLayers() {
  const map = state.map;
  if (!map.getSource('cmp-src')) {
    map.addSource('cmp-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (!map.getLayer('cmp-fill')) {
    map.addLayer({ id: 'cmp-fill', type: 'fill', source: 'cmp-src',
      paint: { 'fill-color': '#00b3a4', 'fill-opacity': 0.14 } });
  }
  if (!map.getLayer('cmp-line')) {
    map.addLayer({ id: 'cmp-line', type: 'line', source: 'cmp-src',
      paint: { 'line-color': '#00b3a4', 'line-width': 3, 'line-dasharray': [2, 1.5], 'line-opacity': 0.95 } });
  }
}

// ---- Timeline panel (multi-year indicators) ----
// A floating, toggleable panel that steps every active indicator layer through the
// years it has data for. The domain is the union of years across the active indicator
// layers (given each layer's current Reporting Level / Display); a layer that lacks the
// chosen year simply keeps its own value that step. Playback speed + loop are settable
// and remembered in localStorage.
const SPEED_PRESETS = { slow: 2500, normal: 1400, fast: 700 };
const timeUI = { range: null, yearOut: null, playBtn: null,
  years: [], year: null, playing: false, timer: null, sliding: false,
  speed: 'normal', loop: true };

// Restore saved playback preferences.
try {
  const saved = JSON.parse(localStorage.getItem('savi.timeline') || '{}');
  if (saved.speed && SPEED_PRESETS[saved.speed]) timeUI.speed = saved.speed;
  if (typeof saved.loop === 'boolean') timeUI.loop = saved.loop;
} catch {}
function saveTimelinePrefs() {
  try { localStorage.setItem('savi.timeline', JSON.stringify({ speed: timeUI.speed, loop: timeUI.loop })); } catch {}
}

function timelinePanel() { return document.getElementById('panel-timeline'); }

function activeIndicatorLayers() {
  return state.catalog.layers.filter(l =>
    l.kind === 'indicator' && state.activeLayerIds.has(l.id));
}

// Sorted union of available years across the active indicator layers.
function computeTimeDomain(layers) {
  const set = new Set();
  layers.forEach(cfg => availableYears(cfg.indicatorId, cfg.sel.level, cfg.sel.display)
    .forEach(y => set.add(String(y))));
  return [...set].sort();
}

// Rebuild the timeline body when the year domain changes; otherwise just sync the handle.
// Auto-shows/hides the panel based on data availability UNTIL the user manually toggles it
// (via the View menu), after which their choice is respected.
function refreshTimeSlider() {
  const panel = timelinePanel();
  if (!panel) return;
  const layers = activeIndicatorLayers();
  const years = layers.length ? computeTimeDomain(layers) : [];

  if (years.length < 2) {
    timeUI.years = [];
    stopPlay();
    renderTimelineEmpty();
    if (!state.timelineTouched) panel.classList.add('hidden');
    return;
  }

  if (years.join('|') !== timeUI.years.join('|')) {
    timeUI.years = years;
    if (!timeUI.year || !years.includes(timeUI.year)) timeUI.year = years[years.length - 1];
    buildTimeSliderDOM();
  } else if (!timeUI.sliding) {
    syncTimeSliderValue();
  }
  if (!state.timelineTouched) panel.classList.remove('hidden');  // auto-reveal when useful
}

// Shown in the panel body when there's no multi-year data to scrub.
function renderTimelineEmpty() {
  const body = document.getElementById('timeline-body');
  if (body) body.innerHTML = '<p class="ts-empty">Add an indicator with multiple years to use the timeline.</p>';
}

function syncTimeSliderValue() {
  if (!timeUI.range) return;
  const i = Math.max(0, timeUI.years.indexOf(timeUI.year));
  timeUI.range.value = String(i);
  if (timeUI.yearOut) timeUI.yearOut.textContent = timeUI.years[i] || '';
}

function buildTimeSliderDOM() {
  const body = document.getElementById('timeline-body');
  if (!body) return;
  body.innerHTML = '';

  // Row 1: play button + slider + year readout.
  const row = document.createElement('div');
  row.className = 'ts-row';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'ts-play';
  playBtn.title = 'Play through the years';
  playBtn.setAttribute('aria-label', 'Play through the years');
  playBtn.textContent = timeUI.playing ? '\u23f8' : '\u25b6';
  playBtn.addEventListener('click', () => (timeUI.playing ? stopPlay() : startPlay()));
  timeUI.playBtn = playBtn;

  const track = document.createElement('div');
  track.className = 'ts-track';

  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'ts-range';
  range.min = '0';
  range.max = String(timeUI.years.length - 1);
  range.step = '1';
  range.value = String(Math.max(0, timeUI.years.indexOf(timeUI.year)));
  range.setAttribute('aria-label', 'Year');
  range.addEventListener('pointerdown', () => { timeUI.sliding = true; stopPlay(); });
  const endSlide = () => { timeUI.sliding = false; };
  range.addEventListener('pointerup', endSlide);
  range.addEventListener('change', endSlide);
  range.addEventListener('input', () => applyYear(timeUI.years[Number(range.value)] || timeUI.year));
  timeUI.range = range;

  const ticks = document.createElement('div');
  ticks.className = 'ts-ticks';
  timeUI.years.forEach(y => {
    const t = document.createElement('span');
    t.className = 'ts-tick';
    t.textContent = y;
    ticks.appendChild(t);
  });

  track.appendChild(range);
  track.appendChild(ticks);

  const yearOut = document.createElement('div');
  yearOut.className = 'ts-year';
  yearOut.textContent = timeUI.year || '';
  timeUI.yearOut = yearOut;

  row.appendChild(playBtn);
  row.appendChild(track);
  row.appendChild(yearOut);

  // Row 2: playback settings — speed + loop.
  const settings = document.createElement('div');
  settings.className = 'ts-settings';

  const speedLabel = document.createElement('label');
  speedLabel.className = 'ts-setting';
  speedLabel.appendChild(document.createTextNode('Speed'));
  const speedSel = document.createElement('select');
  speedSel.className = 'ts-speed';
  [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].forEach(([v, txt]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = txt;
    if (v === timeUI.speed) o.selected = true;
    speedSel.appendChild(o);
  });
  speedSel.addEventListener('change', () => {
    timeUI.speed = speedSel.value;
    saveTimelinePrefs();
    if (timeUI.playing) { stopPlay(); startPlay(); }   // apply new cadence immediately
  });
  speedLabel.appendChild(speedSel);

  const loopLabel = document.createElement('label');
  loopLabel.className = 'ts-setting ts-loop';
  const loopChk = document.createElement('input');
  loopChk.type = 'checkbox';
  loopChk.checked = timeUI.loop;
  loopChk.addEventListener('change', () => { timeUI.loop = loopChk.checked; saveTimelinePrefs(); });
  loopLabel.appendChild(loopChk);
  loopLabel.appendChild(document.createTextNode('Loop'));

  settings.appendChild(speedLabel);
  settings.appendChild(loopLabel);

  body.appendChild(row);
  body.appendChild(settings);
}

// Push a year onto every active indicator layer that has data for it.
function applyYear(year) {
  timeUI.year = year;
  if (timeUI.yearOut) timeUI.yearOut.textContent = year;
  activeIndicatorLayers().forEach(cfg => {
    const ys = availableYears(cfg.indicatorId, cfg.sel.level, cfg.sel.display).map(String);
    if (ys.includes(year) && String(cfg.sel.year) !== year) {
      selectIndicator(cfg.id, { ...cfg.sel, year });
    }
  });
}

function startPlay() {
  if (timeUI.years.length < 2) return;
  timeUI.playing = true;
  if (timeUI.playBtn) timeUI.playBtn.textContent = '\u23f8';
  timeUI.timer = setInterval(() => {
    const i = timeUI.years.indexOf(timeUI.year);
    const atEnd = i >= timeUI.years.length - 1;
    if (atEnd && !timeUI.loop) { stopPlay(); return; }   // one-shot: stop at the last year
    const next = timeUI.years[(i + 1) % timeUI.years.length];
    applyYear(next);
    syncTimeSliderValue();
  }, SPEED_PRESETS[timeUI.speed] || SPEED_PRESETS.normal);
}

function stopPlay() {
  timeUI.playing = false;
  if (timeUI.timer) { clearInterval(timeUI.timer); timeUI.timer = null; }
  if (timeUI.playBtn) timeUI.playBtn.textContent = '\u25b6';
}

// Export the active indicator layers' current values as CSV: one row per geography
// (keyed by reporting level + geoId), one column per active indicator layer at its
// applied display/year. Layers can sit at different levels, so a Level column keeps
// same-id geographies from different levels apart and cells are blank where a layer
// has no value for that row's geography.
async function exportIndicatorsCsv() {
  const layers = orderedCfgs().filter(l => state.activeLayerIds.has(l.id) && l.kind === 'indicator');
  if (!layers.length) { showToast('Add an indicator layer to export its data.'); return; }

  const cols = [];
  const rowMap = new Map();   // "level|geoId" -> { level, name, geoId, cells:{colKey} }
  for (const cfg of layers) {
    const resolved = resolveSelection(cfg.indicatorId, cfg.sel);
    if (!resolved) continue;
    const meta = geometryFor(resolved.level);
    const geojson = await getGeo(resolved.level);
    const valueMap = await getValueMap(cfg.indicatorId, resolved.level, resolved.display, resolved.year);
    const nameMap = new Map();
    (geojson.features || []).forEach(f => {
      const p = f.properties || {};
      nameMap.set(String(p[meta.idProp]), p[meta.nameProp]);
    });
    const colKey = `${cfg.label} — ${resolved.display} (${resolved.year}) [${resolved.level}]`;
    cols.push(colKey);
    Object.entries(valueMap || {}).forEach(([geoId, value]) => {
      const key = `${resolved.level}|${geoId}`;
      let row = rowMap.get(key);
      if (!row) { row = { level: resolved.level, geoId, name: nameMap.get(String(geoId)) || '', cells: {} }; rowMap.set(key, row); }
      row.cells[colKey] = value;
    });
  }
  if (!cols.length || !rowMap.size) { showToast('No data available to export.'); return; }

  const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header = ['Level', 'Geography', 'GeoID', ...cols];
  const rows = [...rowMap.values()]
    .sort((a, b) => a.level.localeCompare(b.level) || String(a.geoId).localeCompare(String(b.geoId)))
    .map(r => [r.level, r.name, r.geoId, ...cols.map(c => r.cells[c] != null ? r.cells[c] : '')]);
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `savi-data-${stamp()}.csv`);
}

// ---- Swipe compare (one map, draggable divider) ----
// The clone (right side) mirrors the active layers; indicator layers are shown at
// the chosen compare year so you can compare the same area across two years.
let compareCfgs = [];

// (Re)build the clone map's layers for a given year. Called on open + year change.
async function populateCompareMap(compareMap, year) {
  compareCfgs.forEach(c => { try { removeLayer(compareMap, c); } catch { /* map torn down */ } });
  compareCfgs = [];
  const ordered = orderedCfgs().filter(l => state.activeLayerIds.has(l.id));
  for (const cfg of ordered) {
    let clone;
    if (cfg.kind === 'indicator') {
      const sel = { ...cfg.sel, year };
      const resolved = resolveSelection(cfg.indicatorId, sel);
      if (!resolved) continue;                 // this layer has no data for that year
      const meta = geometryFor(resolved.level);
      const geojson = await getGeo(resolved.level);
      const valueMap = await getValueMap(cfg.indicatorId, resolved.level, resolved.display, resolved.year);
      clone = { ...cfg, id: 'cmp_' + cfg.id, sel: { ...sel } };
      applyIndicatorSelection(null, clone, {
        ...resolved, geojson, valueMap, idProp: meta.idProp, nameProp: meta.nameProp
      });
    } else {
      clone = { ...cfg, id: 'cmp_' + cfg.id };
    }
    compareCfgs.push(clone);
    await addLayer(compareMap, clone, true);
  }
  applyLayerOrder(compareMap, compareCfgs);
}

// Toggle the swipe view. Requires at least one active indicator layer to compare.
function openSwipeCompare() {
  if (isSwipeOpen()) { closeSwipe(); return; }
  const inds = activeIndicatorLayers();
  if (!inds.length) { showToast('Add an indicator layer, then Swipe to compare years.'); return; }
  const years = computeTimeDomain(inds);
  if (!years.length) { showToast('No year data available to compare.'); return; }
  // Left side reflects the map's current year; right side defaults to the earliest
  // so the two sides contrast out of the box. Both are user-selectable.
  const curLeft = (timeUI.year && years.includes(String(timeUI.year)))
    ? String(timeUI.year)
    : (years.includes(String(inds[0].sel.year)) ? String(inds[0].sel.year) : years[years.length - 1]);
  openSwipe({
    mainMap: state.map,
    styleSpec: basemapStyle(state.currentBasemap),
    years,
    initialYear: years[0],
    initialLeftYear: curLeft,
    populate: populateCompareMap,
    onLeftYear: (year) => { applyYear(year); syncTimeSliderValue(); },
    onClose: () => { compareCfgs = []; }
  });
}

function findLayer(id) {
  return state.catalog.layers.find(l => l.id === id);
}

// Extract the numeric suffix of a dynamic id ("dyn_7" -> 7) for seq bookkeeping.
function seqOf(id) {
  const m = /dyn_(\d+)/.exec(id || '');
  return m ? Number(m[1]) : 0;
}

// Stored so add/delete/select can rebuild the layer panel with current state.
let layerHandlers = null;

function rebuildPanel() {
  if (!layerHandlers) return;
  layerHandlers.order = state.layerOrder;
  layerHandlers.activeLayerIds = state.activeLayerIds;
  buildLayerPanel(state.catalog, layerHandlers);
}

// Distinct-styling for stacked data layers. Solid ramps come first (7 distinct
// colors); once those are used, a see-through pattern is layered on so further
// layers still contrast. Patterned layers drop opacity a touch so whatever sits
// beneath shows through the gaps.
const RAMP_ROTATION = Object.keys(RAMPS);
const PATTERN_ROTATION = ['none', 'diagonal', 'crosshatch', 'dots'];

function styleFor(ramp, pattern) {
  const patterned = pattern && pattern !== 'none';
  return { ramp, pattern, opacity: patterned ? 0.6 : 0.8, patternOpacity: patterned ? 0.9 : 1 };
}

// Pick a ramp + pattern combo not already used by another indicator layer.
function pickDistinctStyle() {
  const used = new Set(
    state.catalog.layers
      .filter(l => l.kind === 'indicator')
      .map(l => `${l.ramp || 'warm'}|${l.pattern || 'none'}`)
  );
  for (const pattern of PATTERN_ROTATION) {
    for (const ramp of RAMP_ROTATION) {
      if (!used.has(`${ramp}|${pattern}`)) return styleFor(ramp, pattern);
    }
  }
  // Every combo taken — fall back to a count-based rotation.
  const n = used.size;
  const ramp = RAMP_ROTATION[n % RAMP_ROTATION.length];
  const pattern = PATTERN_ROTATION[Math.floor(n / RAMP_ROTATION.length) % PATTERN_ROTATION.length];
  return styleFor(ramp, pattern);
}

// Apply a Featured Map: create its dynamic indicator layer(s) (same machinery as
// the saved-map restore path), fly the map to its view, and refresh the UI.
async function applyFeatured(entry) {
  if (!entry || !Array.isArray(entry.dynamic) || !entry.dynamic.length) return;
  await withLoading('Loading featured map\u2026', async () => {
    let added = 0;
    for (const d of entry.dynamic) {
      const cfg = await createIndicatorCfg(d.indicatorId, d.sel, { ramp: d.ramp });
      if (!cfg) continue;
      state.catalog.layers.push(cfg);
      state.layerOrder.unshift(cfg.id);   // new layers start on top
      state.activeLayerIds.add(cfg.id);
      await addLayer(state.map, cfg, true);
      bindPopups(state.map, [cfg]);
      added++;
    }
    if (!added) { showToast('No data available for that featured map.'); return; }
    applyLayerOrder(state.map, orderedCfgs());
    rebuildPanel();
    refreshLegend();
    refreshTimeSlider();
    if (entry.view && state.map) {
      // Phones have a much narrower viewport, so a featured map's desktop-tuned
      // zoom lands too close. Pull it out a bit on small screens only.
      const narrow = window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
      const z = narrow ? Math.max(state.map.getMinZoom(), entry.view.zoom - 1.5) : entry.view.zoom;
      state.map.flyTo({ center: entry.view.center, zoom: z, duration: 900 });
    }
    markDirty();
    showToast('Loaded: ' + (entry.label || 'featured map'));
  });
}

// Add a new dynamic indicator layer from the catalog modal.
async function addIndicatorLayer(indicatorId, geoFilter) {
  await withLoading('Adding data\u2026', async () => {
    // Honor the Add Data geography filter: when a specific level is chosen, seed the
    // layer at that level (otherwise ANY resolves to the indicator's first level).
    const level = (geoFilter && geoFilter !== ANY) ? geoFilter : ANY;
    const cfg = await createIndicatorCfg(indicatorId, { level, display: ANY, year: ANY }, pickDistinctStyle());
    if (!cfg) { showToast('No data available for that indicator.'); return; }
    state.catalog.layers.push(cfg);
    state.layerOrder.unshift(cfg.id);      // new layers start on top
    state.activeLayerIds.add(cfg.id);
    await addLayer(state.map, cfg, true);
    bindPopups(state.map, [cfg]);
    applyLayerOrder(state.map, orderedCfgs());
    rebuildPanel();
    refreshLegend();
    refreshTimeSlider();
    markDirty();
    showToast('Added: ' + cfg.label);
  });
}

// Is an indicator already on the map as a dynamic layer?
function isIndicatorAdded(indicatorId) {
  return state.catalog.layers.some(l => l.indicatorId === indicatorId);
}

// Remove the dynamic layer(s) for an indicator (mirror of addIndicatorLayer).
function removeIndicatorLayer(indicatorId) {
  const cfg = state.catalog.layers.find(l => l.indicatorId === indicatorId);
  if (cfg) deleteLayer(cfg.id);
}

// Clones of the original static catalog layers (keyed by id), captured at load so a
// deleted static layer (e.g. the default Counties boundary, a Sites point layer) can
// be re-created when the user re-adds it from Add Data.
let defaultStaticCfgs = {};

// Turn a static catalog layer on, re-creating it from its pristine clone first if it
// was previously deleted from the panel. Used by Add Data for Counties + Sites.
async function activateStaticLayer(id) {
  let cfg = findLayer(id);
  if (!cfg && defaultStaticCfgs[id]) {
    cfg = JSON.parse(JSON.stringify(defaultStaticCfgs[id]));
    state.catalog.layers.push(cfg);
  }
  if (!cfg) return;
  state.activeLayerIds.add(cfg.id);
  if (!state.layerOrder.includes(cfg.id)) state.layerOrder.unshift(cfg.id);
  await addLayer(state.map, cfg, true);
  // The layer may already exist from init (static layers load hidden, visible:false),
  // in which case addLayer is a no-op — so force it visible here either way.
  updateLayerVisibility(state.map, cfg, true);
  bindPopups(state.map, [cfg]);
  applyLayerOrder(state.map, orderedCfgs());
  rebuildPanel(); refreshLegend(); markDirty();
}

// Turn a static catalog layer off but keep it in the panel (so its slider/remove
// controls stay available). Safe no-op if it isn't present.
function deactivateStaticLayer(id) {
  const cfg = findLayer(id);
  if (!cfg) return;
  state.activeLayerIds.delete(cfg.id);
  updateLayerVisibility(state.map, cfg, false);
  rebuildPanel(); refreshLegend(); markDirty();
}

// ---- Boundary overlays (the 7 SAVI geography levels) ----
// Outline-only polygon layers from the prefetched boundary geojsons, offered under
// a "Boundaries" category in Add Data. Counties is also the default on-map boundary
// (the static 'counties' catalog layer), so its entry just toggles that layer.
const BOUNDARY_TYPES = [
  { key: 'counties',    label: 'Counties',                       source: 'data/geo_counties.geojson',    staticId: 'counties', color: '#1a6ec2' },
  { key: 'tracts',      label: '2010 Census Tracts',             source: 'data/geo_tracts.geojson',      color: '#8338ec' },
  { key: 'blockgroups', label: '2010 Block Groups',              source: 'data/geo_blockgroups.geojson', color: '#3a86ff' },
  { key: 'townships',   label: 'Townships',                      source: 'data/geo_townships.geojson',   color: '#fb5607' },
  { key: 'schools',     label: 'School Corporations',            source: 'data/geo_schools.geojson',     color: '#2a9d8f' },
  { key: 'zcta',        label: 'ZIP Code Tabulation Areas 2010', source: 'data/geo_zcta.geojson',        color: '#e76f51' },
  { key: 'msa',         label: 'Metropolitan Statistical Area',  source: 'data/geo_msa.geojson',         color: '#6a4c93' }
];
function boundaryType(key) { return BOUNDARY_TYPES.find(t => t.key === key); }

// Build an outline-only boundary layer config (very light fill so clicks register
// for the name popup, strong colored outline).
function createBoundaryCfg(t) {
  return {
    id: 'bnd_' + t.key,
    kind: 'boundary',
    boundaryKey: t.key,
    label: t.label + ' boundaries',
    category: 'boundaries',
    geometry: 'polygon',
    source: t.source,
    visible: true,
    opacity: 1,
    level: t.label,   // shown as the info-window subtitle so the boundary type is clear
    paint: { 'fill-color': t.color, 'fill-opacity': 0.04, 'line-color': t.color, 'line-width': 1.2 },
    labelField: 'name',
    popup: { title: 'name', fields: [] },
    legend: [{ type: 'polygon', color: t.color, outline: t.color, label: t.label }]
  };
}

function isBoundaryAdded(key) {
  const t = boundaryType(key);
  if (!t) return false;
  if (t.staticId) return state.activeLayerIds.has(t.staticId);   // counties: on map == visible
  return state.catalog.layers.some(l => l.id === 'bnd_' + key);
}

async function addBoundaryLayer(key) {
  const t = boundaryType(key);
  if (!t) return;
  // Counties: (re)activate the default static catalog layer, re-creating it if the
  // user had deleted it from the panel (so it can always be added back).
  if (t.staticId) {
    await activateStaticLayer(t.staticId);
    return;
  }
  await withLoading('Adding boundaries\u2026', async () => {
    const cfg = createBoundaryCfg(t);
    state.catalog.layers.push(cfg);
    state.layerOrder.unshift(cfg.id);      // new overlays start on top
    state.activeLayerIds.add(cfg.id);
    await addLayer(state.map, cfg, true);
    bindPopups(state.map, [cfg]);
    applyLayerOrder(state.map, orderedCfgs());
    rebuildPanel(); refreshLegend(); markDirty();
    showToast('Added: ' + t.label + ' boundaries');
  });
}

function removeBoundaryLayer(key) {
  const t = boundaryType(key);
  if (!t) return;
  // Counties: deactivate the static layer but keep it in the panel.
  if (t.staticId) { deactivateStaticLayer(t.staticId); return; }
  deleteLayer('bnd_' + key);
}

// Open the Add Data catalog with add/remove toggle + already-selected state.
// A "Boundaries" category (the 7 SAVI geographies) is injected via extraItems;
// its ids are prefixed "bnd:" so the handlers route to the boundary machinery.
function openAddData() {
  const boundaryItems = BOUNDARY_TYPES.map(t => ({ id: 'bnd:' + t.key, label: t.label, path: 'Boundaries' }));
  // Point datasets (Sites, Programs & Agencies) are on-demand static layers, listed
  // from their pristine clones. Adding re-creates one; removing deletes it outright
  // so it doesn't linger in the panel or auto-reappear on New Map / reload.
  const siteItems = Object.values(defaultStaticCfgs)
    .filter(l => l.category === 'sites' && l.geometry === 'point')
    .map(l => ({ id: 'ste:' + l.id, label: l.label, path: 'Sites, Programs & Agencies' }));
  const isBnd = id => typeof id === 'string' && id.startsWith('bnd:');
  const isSte = id => typeof id === 'string' && id.startsWith('ste:');
  openCatalogModal({
    extraItems: boundaryItems.concat(siteItems),
    onAdd: (id, geo) => (isBnd(id) ? addBoundaryLayer(id.slice(4))
      : isSte(id) ? activateStaticLayer(id.slice(4)) : addIndicatorLayer(id, geo)),
    onRemove: id => (isBnd(id) ? removeBoundaryLayer(id.slice(4))
      : isSte(id) ? deleteLayer(id.slice(4)) : removeIndicatorLayer(id)),
    isAdded: id => (isBnd(id) ? isBoundaryAdded(id.slice(4))
      : isSte(id) ? !!findLayer(id.slice(4)) : isIndicatorAdded(id))
  });
}

// Remove any layer from the map + catalog.
function deleteLayer(layerId) {
  const cfg = findLayer(layerId);
  if (!cfg) return;
  removeLayer(state.map, cfg);
  state.catalog.layers = state.catalog.layers.filter(l => l.id !== layerId);
  state.layerOrder = state.layerOrder.filter(id => id !== layerId);
  state.activeLayerIds.delete(layerId);
  rebuildPanel();
  refreshLegend();
  refreshTimeSlider();
  markDirty();
}

// Bulk-remove layers. scope 'all' = every layer in the panel; 'hidden' = only the
// layers whose checkbox is unchecked (not currently visible). Batches one panel
// rebuild instead of per-layer (unlike calling deleteLayer in a loop).
function clearLayers(scope) {
  const ids = state.catalog.layers
    .filter(l => scope === 'all' || !state.activeLayerIds.has(l.id))
    .map(l => l.id);
  if (!ids.length) {
    showToast(scope === 'all' ? 'No layers to clear.' : 'No hidden layers to clear.');
    return;
  }
  const drop = new Set(ids);
  ids.forEach(id => { const cfg = findLayer(id); if (cfg) removeLayer(state.map, cfg); });
  state.catalog.layers = state.catalog.layers.filter(l => !drop.has(l.id));
  state.layerOrder = state.layerOrder.filter(id => !drop.has(id));
  ids.forEach(id => state.activeLayerIds.delete(id));
  rebuildPanel();
  refreshLegend();
  refreshTimeSlider();
  markDirty();
  const n = ids.length;
  showToast(scope === 'all'
    ? `Cleared ${n} layer${n === 1 ? '' : 's'}.`
    : `Cleared ${n} hidden layer${n === 1 ? '' : 's'}.`);
}

// Modal (not a native browser prompt) asking whether to clear all layers or just
// the hidden ones. Picking a choice is itself the confirmation, so clearLayers()
// runs without an extra window.confirm.
function openClearDialog() {
  const total = state.catalog.layers.length;
  if (!total) { showToast('No layers to clear.'); return; }
  const hidden = state.catalog.layers.filter(l => !state.activeLayerIds.has(l.id)).length;

  const overlay = document.createElement('div');
  overlay.className = 'savemap-overlay open';
  overlay.innerHTML = `
    <div class="savemap-modal clear-modal" role="dialog" aria-modal="true" aria-label="Clear layers">
      <div class="savemap-header">
        <span>Clear layers</span>
        <button class="savemap-close" type="button" aria-label="Close">\u00d7</button>
      </div>
      <div class="savemap-body">
        <p class="clear-msg">Remove layers from the map. This can\u2019t be undone.</p>
        <div class="clear-choices">
          <button class="savemap-btn savemap-primary" data-act="all" type="button">
            Clear all <span class="clear-count">${total}</span>
          </button>
          <button class="savemap-btn savemap-secondary" data-act="hidden" type="button"${hidden ? '' : ' disabled'}>
            Clear hidden <span class="clear-count">${hidden}</span>
          </button>
        </div>
      </div>
      <div class="savemap-footer">
        <button class="savemap-btn savemap-cancel" type="button">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.savemap-close').addEventListener('click', close);
  overlay.querySelector('.savemap-cancel').addEventListener('click', close);
  overlay.querySelector('[data-act="all"]').addEventListener('click', () => { close(); clearLayers('all'); });
  const hiddenBtn = overlay.querySelector('[data-act="hidden"]');
  if (hidden) hiddenBtn.addEventListener('click', () => { close(); clearLayers('hidden'); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  setTimeout(() => overlay.querySelector('[data-act="all"]').focus(), 30);
}

// Apply a new Reporting Level / Display / Year selection to a dynamic layer.
async function selectIndicator(layerId, sel) {
  const cfg = findLayer(layerId);
  if (!cfg) return;
  cfg.sel = { ...sel };
  const resolved = resolveSelection(cfg.indicatorId, sel);
  if (!resolved) { showToast('No data for that combination.'); return; }
  const meta = geometryFor(resolved.level);
  const geojson = await getGeo(resolved.level);
  const valueMap = await getValueMap(cfg.indicatorId, resolved.level, resolved.display, resolved.year);
  applyIndicatorSelection(state.map, cfg, {
    ...resolved, geojson, valueMap, idProp: meta.idProp, nameProp: meta.nameProp
  });
  updateRowSubtitle(cfg);
  refreshLegend();
  markDirty();
}

// Keep the layer row's subtitle in sync with the applied selection (e.g. after the
// time slider changes a layer's year without a full panel rebuild).
function updateRowSubtitle(cfg) {
  const row = document.querySelector(`.layer-item[data-layer-id="${cfg.id}"] .layer-sub`);
  if (!row) return;
  const parts = [cfg.level, cfg.display, cfg.year].filter(v => v != null && v !== '');
  if (parts.length) { row.textContent = parts.join(' \u00b7 '); row.title = parts.join(' \u00b7 ') + ' \u2014 click to adjust variables'; }
}

// ---- Shareable permalink: encode captureMapState() into the URL hash (#m=...) ----
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(s)));
}
function buildPermalink() {
  const json = JSON.stringify(captureMapState());
  return location.origin + location.pathname + '#m=' + b64urlEncode(json);
}
// Parse a permalink map state from the current URL hash, or null if absent/invalid.
function readPermalink() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return null;
  const m = new URLSearchParams(h).get('m');
  if (!m) return null;
  try { return JSON.parse(b64urlDecode(m)); } catch { return null; }
}
async function copyPermalink() {
  const url = buildPermalink();
  history.replaceState(null, '', url); // reflect it in the address bar
  try {
    await navigator.clipboard.writeText(url);
    showToast('Shareable link copied to clipboard.');
  } catch {
    showToast('Link is in the address bar \u2014 copy it to share.');
  }
}

// Share the current view: on devices with a native share sheet (phones), hand off
// to the OS so the link can go to Messages/Mail/etc.; otherwise copy to clipboard.
async function shareCurrentView() {
  const url = buildPermalink();
  history.replaceState(null, '', url); // reflect it in the address bar either way
  const shareData = {
    title: 'Community Data Map',
    text: 'Check out this Community Data Map view',
    url
  };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (e) { if (e && e.name === 'AbortError') return; /* fall through to copy */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Shareable link copied to clipboard.');
  } catch {
    showToast('Link is in the address bar \u2014 copy it to share.');
  }
}

// Snapshot the current map (basemap, order, active set, view, per-layer styles).
function captureMapState() {
  return {
    v: 1,
    basemap: state.currentBasemap,
    buildings3d: state.buildings3d,
    order: state.layerOrder.slice(),
    active: Array.from(state.activeLayerIds),
    view: {
      center: state.map.getCenter().toArray(),
      zoom: state.map.getZoom(),
      bearing: state.map.getBearing(),   // right-drag rotation
      pitch: state.map.getPitch()        // right-drag tilt
    },
    styles: state.catalog.layers.map(l => ({
      id: l.id,
      label: l.label,          // user renames ride along with the saved map
      opacity: l.opacity,
      ramp: l.ramp,
      pattern: l.pattern,
      patternColor: l.patternColor,
      patternOpacity: l.patternOpacity,
      paint: l.paint,
      choroplethColors: l.choropleth ? l.choropleth.stops.map(s => s.color) : null
    })),
    // Dynamic indicator layers must be recreated from scratch on restore.
    dynamic: state.catalog.layers.filter(l => l.kind === 'indicator').map(l => ({
      id: l.id,
      indicatorId: l.indicatorId,
      sel: l.sel,
      ramp: l.ramp,
      opacity: l.opacity,
      pattern: l.pattern,
      patternColor: l.patternColor,
      patternOpacity: l.patternOpacity,
      classify: l.classify
    })),
    // Named "Places" (pin) layers, recreated from coordinates + metadata on restore.
    places: placesLayers().map(l => ({
      id: l.id,
      label: l.label,
      points: l.sourceData.features.map(f => ({
        name: f.properties.name,
        pid: f.properties.pid,
        lng: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        meta: Array.isArray(f.properties.meta) ? f.properties.meta : []
      }))
    })),
    // Boundary overlays: recreated from the boundary key (geometry fetched on restore).
    boundaries: state.catalog.layers
      .filter(l => l.kind === 'boundary')
      .map(l => ({ key: l.boundaryKey, opacity: l.opacity, paint: l.paint })),
    // Imported (GeoJSON/KML) layers: the whole feature collection is stored inline,
    // plus the (possibly restyled) paint/opacity, and rebuilt verbatim on restore.
    imported: importedLayers().map(l => ({
      id: l.id,
      label: l.label,
      geometry: l.geometry,
      opacity: l.opacity,
      paint: l.paint,
      sourceData: l.sourceData
    })),
    // Transient UI state, so a reopened map is pixel-for-pixel where you left it.
    compare: state.compareSet.slice(),
    legendHighlight: state.legendHighlight
      ? { layerId: state.legendHighlight.layerId, indices: state.legendHighlight.indices.slice() }
      : null,
    // Map-control visibility (View menu: zoom / fullscreen / locate / distance scale).
    controls: {
      zoom: controlPref('zoom'),
      fullscreen: controlPref('fullscreen'),
      locate: controlPref('locate'),
      scale: controlPref('scale')
    },
    // Floating panels: open/closed, collapsed, and any dragged (floated) position.
    panels: Array.from(document.querySelectorAll('.float-panel')).map(p => ({
      id: p.id,
      hidden: p.classList.contains('hidden'),
      collapsed: p.classList.contains('collapsed'),
      floated: p.style.position === 'fixed',
      left: p.style.left || '',
      top: p.style.top || '',
      width: p.style.width || '',
      height: p.style.height || ''
    }))
  };
}

// Apply a saved snapshot's control visibility + floating-panel layout. Called after
// the toolbar/panels are wired (so the elements and controls exist). Restores the
// View-menu control toggles and each panel's open/closed/collapsed/dragged state.
// Keep the --toolbar-h CSS variable in sync with the toolbar's rendered height so
// the left/right docks start just below it. The toolbar wraps on narrow screens,
// so its height changes with the viewport width.
function syncToolbarHeight() {
  const bar = document.getElementById('toolbar');
  if (!bar) return;
  const set = () => document.documentElement.style.setProperty('--toolbar-h', bar.offsetHeight + 'px');
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(bar);
  else window.addEventListener('resize', set);
}

// Collapse a panel to just its title bar without marking the map dirty (mirrors
// makeCollapsible's button sync, but silent — used for the mobile default).
function collapsePanelById(id) {
  const p = document.getElementById(id);
  if (!p || p.classList.contains('collapsed')) return;
  p.classList.add('collapsed');
  const btn = p.querySelector('.collapse-btn');
  if (btn) { btn.textContent = '+'; btn.setAttribute('aria-label', 'Expand panel'); }
}

function applySavedUiState(saved) {
  if (!saved) return;
  if (saved.controls) {
    ['zoom', 'fullscreen', 'locate', 'scale'].forEach(k => {
      if (typeof saved.controls[k] === 'boolean') setControlPref(k, saved.controls[k]);
    });
    applyControlVisibility();
  }
  if (Array.isArray(saved.panels)) {
    // The saved layout is explicit, so don't let auto-show re-open the timeline.
    if (saved.panels.some(ps => ps.id === 'panel-timeline')) state.timelineTouched = true;
    saved.panels.forEach(ps => {
      const p = document.getElementById(ps.id);
      if (!p) return;
      p.classList.toggle('hidden', !!ps.hidden);
      p.classList.toggle('collapsed', !!ps.collapsed);
      if (ps.floated && ps.left && ps.top) {
        p.style.position = 'fixed';
        p.style.margin = '0';
        p.style.right = 'auto';
        p.style.bottom = 'auto';
        p.style.transform = 'none';
        p.style.left = ps.left;
        p.style.top = ps.top;
      }
      // A custom size (from the resize grip) persists whether docked or floated.
      if (ps.width) p.style.width = ps.width;
      if (ps.height) {
        p.style.height = ps.height;
        p.style.maxHeight = 'none';
        const body = p.querySelector('.float-panel-body');
        if (body) body.style.maxHeight = 'none';
      }
    });
  }
}

// Apply a saved snapshot onto the catalog + state BEFORE the map/layers build,
// so addLayer/applyLayerOrder pick up the restored styles, order, and visibility.
function applySavedToCatalog(saved) {
  if (saved.basemap && BASEMAPS[saved.basemap]) state.currentBasemap = saved.basemap;
  if (typeof saved.buildings3d === 'boolean') state.buildings3d = saved.buildings3d;

  if (Array.isArray(saved.order)) {
    const known = saved.order.filter(id => findLayer(id));
    // Append any catalog layers missing from the saved order (e.g. new datasets).
    state.catalog.layers.forEach(l => { if (!known.includes(l.id)) known.push(l.id); });
    state.layerOrder = known;
  }
  if (Array.isArray(saved.active)) {
    state.activeLayerIds = new Set(saved.active.filter(id => findLayer(id)));
  }
  (saved.styles || []).forEach(s => {
    const l = findLayer(s.id);
    if (!l) return;
    if (s.label) l.label = s.label;   // restore user renames
    if (s.opacity != null) l.opacity = s.opacity;
    if (s.ramp) l.ramp = s.ramp;
    if (s.pattern) l.pattern = s.pattern;
    if (s.patternColor) l.patternColor = s.patternColor;
    if (s.patternOpacity != null) l.patternOpacity = s.patternOpacity;
    if (s.paint) {
      l.paint = { ...(l.paint || {}), ...s.paint };
      // Keep the legend swatch in sync with a restyled primary color (choropleth
      // stops are handled separately below). Without this, a recolored Places/point
      // /line/area layer shows its restored map color but a stale legend swatch.
      if (!l.choropleth && l.legend && l.legend[0]) {
        const prim = l.geometry === 'point' ? l.paint['circle-color']
          : l.geometry === 'line' ? l.paint['line-color']
            : l.paint['fill-color'];
        if (prim) l.legend[0].color = prim;
      }
    }
    if (s.choroplethColors && l.choropleth) {
      l.choropleth.stops.forEach((st, i) => { if (s.choroplethColors[i]) st.color = s.choroplethColors[i]; });
      if (l.legend) l.legend.forEach((e, i) => { if (l.choropleth.stops[i]) e.color = l.choropleth.stops[i].color; });
    }
  });

  // Transient UI state (the map on-screen picks these up once layers are live).
  if (Array.isArray(saved.compare)) {
    state.compareSet = saved.compare
      .filter(g => g && g.level && g.id != null)
      .map(g => ({ level: g.level, id: String(g.id), name: g.name }));
  }
}

function refreshLegend() {
  const active = orderedCfgs().filter(l => state.activeLayerIds.has(l.id));
  buildLegend(active, {
    onLegendClass: toggleLegendClass,
    onLegendReset: resetLegendClass,
    activeHighlight: state.legendHighlight,
    onZoomToLayer: zoomToLayerExtent
  });
}

// Zoom/fit the map to the extent of a layer's features (used by the Places legend).
// Asks for confirmation first so an accidental legend click doesn't jump the view.
function zoomToLayerExtent(layer) {
  const feats = (layer && layer.sourceData && layer.sourceData.features) || [];
  if (!feats.length || !state.map) return;
  const n = feats.length;
  openConfirm(
    `Zoom the map to fit the ${n} place${n === 1 ? '' : 's'} in \u201c${layer.label}\u201d?`,
    () => {
      const bounds = new maplibregl.LngLatBounds();
      feats.forEach(f => { if (f.geometry && f.geometry.coordinates) bounds.extend(f.geometry.coordinates); });
      try { state.map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 900 }); } catch { /* bad bounds */ }
    },
    { confirmLabel: 'Zoom' }
  );
}

// Lightweight confirmation dialog (centered modal). Runs onConfirm() if accepted.
function openConfirm(message, onConfirm, opts = {}) {
  const old = document.getElementById('confirm-overlay');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.className = 'cmp-overlay open';
  overlay.id = 'confirm-overlay';
  const modal = document.createElement('div');
  modal.className = 'cmp-modal confirm-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Confirm');

  const p = document.createElement('p');
  p.className = 'confirm-msg';
  p.textContent = message;
  modal.appendChild(p);

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'tb-btn tb-primary'; ok.textContent = opts.confirmLabel || 'Confirm';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'tb-btn'; cancel.textContent = 'Cancel';
  actions.append(ok, cancel);
  modal.appendChild(actions);

  const close = () => overlay.remove();
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  ok.addEventListener('click', () => { close(); if (typeof onConfirm === 'function') onConfirm(); });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  ok.focus();
}

// Clicking a legend's main title/icon clears any class emphasis on that layer,
// restoring the original coloring for all geographies.
function resetLegendClass(layer) {
  const hl = state.legendHighlight;
  if (!hl || hl.layerId !== layer.id) return;
  clearLegendHighlight();
  refreshLegend();
}

// Emphasize the features of one or more choropleth breaks by dimming the rest.
// Each click toggles a break on/off independently (like a checkbox): click an
// unselected break to add it, click a selected one to remove it. Selecting a break
// on a different layer starts a fresh selection. Reversible (restores normal opacity).
function toggleLegendClass(layer, index /* additive: no longer required */) {
  const cur = state.legendHighlight;
  const sameLayer = cur && cur.layerId === layer.id;
  let indices;
  if (sameLayer) {
    const set = new Set(cur.indices);
    if (set.has(index)) set.delete(index); else set.add(index);
    indices = [...set];
  } else {
    indices = [index];  // first break for this layer
  }
  clearLegendHighlight();
  if (indices.length) applyLegendHighlight(layer, indices);
  refreshLegend();
}

function applyLegendHighlight(layer, indices) {
  const stops = layer.choropleth && layer.choropleth.stops;
  const fillId = `${layer.id}-fill`;
  if (!stops || !state.map.getLayer(fillId)) return;
  const list = [...indices].filter(i => i >= 0 && i < stops.length).sort((a, b) => a - b);
  if (!list.length) return;
  const v = ['get', 'value'];
  const bucketExpr = (index) => index === 0
    ? ['<=', v, stops[0].value]
    : ['all', ['>', v, stops[index - 1].value], ['<=', v, stops[index].value]];
  const inAny = list.length === 1 ? bucketExpr(list[0]) : ['any', ...list.map(bucketExpr)];
  const base = layer.opacity != null ? layer.opacity : 0.8;
  state.map.setPaintProperty(fillId, 'fill-opacity', ['case', inAny, base, base * 0.12]);
  state.legendHighlight = { layerId: layer.id, indices: list };
}

function clearLegendHighlight() {
  const hl = state.legendHighlight;
  state.legendHighlight = null;
  if (!hl) return;
  const cfg = state.catalog.layers.find(l => l.id === hl.layerId);
  const fillId = `${hl.layerId}-fill`;
  if (cfg && state.map.getLayer(fillId)) {
    updateLayerOpacity(state.map, cfg, cfg.opacity != null ? cfg.opacity : 0.8);
  }
}

// Flag the map as having unsaved changes (shows the dot on the Map menu button).
function markDirty() {
  setSaveDirty(true);
  scheduleAutosave();
}

// Like markDirty but persists NOW (no debounce). Use for discrete, important state
// changes — e.g. showing/hiding a panel — so a quick refresh can't drop them even on
// browsers where the pagehide/visibilitychange flush is unreliable.
function markDirtyNow() {
  setSaveDirty(true);
  if (state.autosaveTimer) { clearTimeout(state.autosaveTimer); state.autosaveTimer = null; }
  doAutosave();
}

// Ensure there's a saved map to autosave into. If none is active (user never did a
// manual "Save Map"), create one automatically using the suggested name, mark it
// active, and persist it. Returns the active map id (or null if the save failed).
function ensureAutosaveMap() {
  if (state.activeMapId && getSavedMap(state.activeMapId)) return state.activeMapId;
  const suggestion = suggestSaveMeta();
  const name = (suggestion && suggestion.name) || 'Autosaved map';
  const id = saveNamedMap({ name, description: (suggestion && suggestion.description) || '', state: captureMapState() });
  state.activeMapId = id;
  setActiveMapId(id);
  return id;
}

// Debounced autosave: when enabled, persist the current view after a short quiet
// period. Auto-creates a saved map on first use so autosave works even if you never
// did a manual "Save Map".
function doAutosave() {
  if (!state.autosave) return;
  ensureAutosaveMap();
  const active = state.activeMapId ? getSavedMap(state.activeMapId) : null;
  if (!active) return;   // save failed (e.g. storage full)
  saveNamedMap({ id: active.id, name: active.name, description: active.description, state: captureMapState() });
  setSaveDirty(false);
}

function scheduleAutosave() {
  if (!state.autosave) return;
  if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(() => { state.autosaveTimer = null; doAutosave(); }, 1500);
}

// Persist a pending autosave immediately. The debounce means a quick refresh (or
// tab close) within ~1.5s of a change would otherwise drop it — e.g. hide a panel
// then refresh and it reappears. Flush on page hide so the last change survives.
function flushAutosave() {
  if (!state.autosaveTimer) return;
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = null;
  doAutosave();
}
window.addEventListener('pagehide', flushAutosave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAutosave();
});

// 3D buildings: a single key-free OpenFreeMap vector source + fill-extrusion layer that
// rides on top of whatever raster basemap is active. Building data only exists at z14+.
// Added UNDER the data overlays (callers re-run applyLayerOrder to keep choropleths on top).
function ensure3DBuildings() {
  const map = state.map;
  if (!map) return;
  if (state.buildings3d) {
    if (!map.getSource('openmaptiles')) {
      map.addSource('openmaptiles', {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: '\u00a9 OpenMapTiles \u00a9 OpenStreetMap contributors'
      });
    }
    if (!map.getLayer('building-3d')) {
      map.addLayer({
        id: 'building-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-extrusion-base': ['get', 'render_min_height'],
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-color': 'hsl(35, 8%, 72%)',
          'fill-extrusion-opacity': 0.85
        }
      });
    }
  } else {
    if (map.getLayer('building-3d')) map.removeLayer('building-3d');
    if (map.getSource('openmaptiles')) map.removeSource('openmaptiles');
  }
}

// Toggle 3D buildings from the UI. Adds/removes the overlay, keeps data layers on top,
// and (when turning on) tilts the camera + zooms to where buildings become visible.
function set3DBuildings(on) {
  state.buildings3d = !!on;
  ensure3DBuildings();
  if (state.buildings3d) {
    applyLayerOrder(state.map, orderedCfgs());      // push data choropleths back above buildings
    if (state.highlightData) ensureHighlightLayers();
    if (state.compareSet.length) refreshCompareHighlight();
    const ease = {};
    if (state.map.getPitch() < 1) ease.pitch = 55;  // flat view hides extrusions — tilt in
    if (state.map.getZoom() < 14) ease.zoom = 15;   // buildings only exist at z14+
    if (Object.keys(ease).length) state.map.easeTo({ ...ease, duration: 700 });
  }
  const cb = document.getElementById('buildings3d-toggle');
  if (cb) cb.checked = state.buildings3d;
  markDirty();
}

function switchBasemap(key) {
  if (key === state.currentBasemap) return;
  if (isSwipeOpen()) closeSwipe();   // clone keeps its own basemap — exit to avoid a mismatch
  state.currentBasemap = key;
  const map = state.map;

  // Setting a new style wipes custom sources/layers, so re-add them after load.
  map.setStyle(basemapStyle(key));
  map.once('styledata', async () => {
    await reAddAllLayers(map, state.catalog.layers, state.activeLayerIds);
    ensure3DBuildings();   // the new raster style wiped it — re-add under the data layers
    applyLayerOrder(map, orderedCfgs());
    bindPopups(map, state.catalog.layers);
    if (state.highlightData) ensureHighlightLayers();  // survive basemap swap
    if (state.compareSet.length) refreshCompareHighlight();
  });

  // Update button active states
  document.querySelectorAll('.basemap-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.basemap === key);
  });
  markDirty();
}

init().catch(err => {
  console.error('SAVI init failed:', err);
  const panel = document.getElementById('layer-panel');
  if (panel) panel.innerHTML = '<p style="color:#b00;font-size:12px">Failed to load. Serve via a local web server (see README/plan) — file:// blocks fetch of local data.</p>';
});
