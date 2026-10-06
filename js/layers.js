// SAVI — layer management: add/remove/style layers from config + popups.

import { makeDraggable } from './panels.js?v=97';

const loadedSources = new Set();

// Preset 5-class choropleth color ramps (ordered low value -> high value).
export const RAMPS = {
  warm:    { label: 'Warm (Yl-Or-Rd)', colors: ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'] },
  blues:   { label: 'Blues',           colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'] },
  greens:  { label: 'Greens',          colors: ['#edf8e9', '#bae4b3', '#74c476', '#31a354', '#006d2c'] },
  purples: { label: 'Purples',         colors: ['#f2f0f7', '#cbc9e2', '#9e9ac8', '#756bb1', '#54278f'] },
  reds:    { label: 'Reds',            colors: ['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15'] },
  teal:    { label: 'Teal (Yl-Gn-Bu)', colors: ['#ffffcc', '#a1dab4', '#41b6c4', '#2c7fb8', '#253494'] },
  viridis: { label: 'Viridis',         colors: ['#fde725', '#5ec962', '#21918c', '#3b528b', '#440154'] }
};

// Build a MapLibre paint object from a layer config, per geometry type.
function fillPaint(cfg) {
  const p = cfg.paint || {};
  const paint = {
    'fill-color': p['fill-color'] || '#888888',
    'fill-opacity': (p['fill-opacity'] != null ? p['fill-opacity'] : 0.4) * (cfg.opacity != null ? cfg.opacity : 1)
  };
  // Choropleth overrides fill-color with a data-driven expression.
  if (cfg.choropleth) {
    paint['fill-color'] = choroplethExpr(cfg.choropleth);
    paint['fill-opacity'] = (cfg.opacity != null ? cfg.opacity : 0.8);
  }
  return paint;
}

function linePaint(cfg) {
  const p = cfg.paint || {};
  // For polygon/choropleth layers with only a generic outline, use the layer's
  // accent so overlapping (same-geometry) edges stay distinguishable.
  const generic = !p['line-color'] || p['line-color'] === '#666' || p['line-color'] === '#666666' || p['line-color'] === '#555555';
  const lineColor = (cfg.geometry === 'polygon' && generic) ? accentColor(cfg) : (p['line-color'] || '#333333');
  return {
    // On choropleth (data) layers, no-data geographies get a transparent outline so
    // they disappear completely (matching the transparent fill). Boundary overlays
    // have no cfg.choropleth, so their outlines always show.
    'line-color': cfg.choropleth ? choroplethLineColor(cfg, lineColor) : lineColor,
    'line-width': p['line-width'] != null ? p['line-width'] : 1,
    'line-opacity': cfg.opacity != null ? cfg.opacity : 1
  };
}

// Line color for a choropleth layer: transparent where the field is null (no data
// reported), the given base color otherwise.
function choroplethLineColor(cfg, baseColor) {
  return ['case', ['==', ['get', cfg.choropleth.field], null], 'rgba(0,0,0,0)', baseColor];
}

// Derive a single representative accent color for a layer from its style config.
export function accentColor(cfg) {
  if (cfg.choropleth && cfg.choropleth.stops && cfg.choropleth.stops.length) {
    return cfg.choropleth.stops[cfg.choropleth.stops.length - 1].color;
  }
  const p = cfg.paint || {};
  if (cfg.geometry === 'point') {
    if (cfg.categoryStyle) {
      const vals = Object.values(cfg.categoryStyle.values || {});
      if (vals.length) return vals[0];
      if (cfg.categoryStyle.default) return cfg.categoryStyle.default;
    }
    return p['circle-color'] || '#e6550d';
  }
  if (cfg.geometry === 'line') return p['line-color'] || '#333333';
  return p['fill-color'] || '#888888';
}

// Ordered sub-layer sequence bottom→top (within a polygon: fill, pattern, then line).
function orderedSubLayerIds(cfg) {
  if (cfg.geometry === 'polygon') return [`${cfg.id}-fill`, `${cfg.id}-pattern`, `${cfg.id}-line`];
  return subLayerIds(cfg);
}

// Apply z-order: orderedCfgs[0] = top of panel = top of map.
// Move sub-layers bottom→top so the last moved ends on top; basemap stays beneath.
export function applyLayerOrder(map, orderedCfgs) {
  // Panel order top→bottom; map draw order needs bottom→top, so reverse.
  const bottomToTop = orderedCfgs.slice().reverse();
  bottomToTop.forEach(cfg => {
    orderedSubLayerIds(cfg).forEach(id => {
      if (map.getLayer(id)) map.moveLayer(id);
    });
  });
}

function circlePaint(cfg) {
  const p = cfg.paint || {};
  return {
    'circle-radius': p['circle-radius'] != null ? p['circle-radius'] : 5,
    'circle-color': cfg.categoryStyle ? categoryColorExpr(cfg.categoryStyle) : (p['circle-color'] || '#e6550d'),
    'circle-stroke-width': p['circle-stroke-width'] != null ? p['circle-stroke-width'] : 1,
    'circle-stroke-color': p['circle-stroke-color'] || '#ffffff',
    'circle-opacity': cfg.opacity != null ? cfg.opacity : 1,
    'circle-stroke-opacity': cfg.opacity != null ? cfg.opacity : 1
  };
}

function choroplethExpr(ch) {
  const interp = ['interpolate', ['linear'], ['to-number', ['get', ch.field]]];
  ch.stops.forEach(s => { interp.push(s.value, s.color); });
  // No-data geographies (field value is null) render fully transparent; only
  // geographies that actually report a value get a choropleth color.
  return ['case', ['==', ['get', ch.field], null], 'rgba(0,0,0,0)', interp];
}

function categoryColorExpr(cs) {
  const expr = ['match', ['get', cs.field]];
  Object.entries(cs.values).forEach(([k, v]) => { expr.push(k, v); });
  expr.push(cs.default || '#636363');
  return expr;
}

// The MapLibre layer ids generated for a config (a polygon => fill + pattern + line).
function subLayerIds(cfg) {
  if (cfg.geometry === 'polygon') return [`${cfg.id}-fill`, `${cfg.id}-pattern`, `${cfg.id}-line`];
  if (cfg.geometry === 'point') return [`${cfg.id}-circle`];
  if (cfg.geometry === 'line') return [`${cfg.id}-line`];
  return [`${cfg.id}-layer`];
}

// ---- Fill patterns (cross-hatching etc.) ----
// Generate a small tileable pattern image tinted with a color.
function makePatternImage(kind, color, size = 16) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  const lines = (slopeUp) => {
    ctx.beginPath();
    for (let o = -size; o <= size * 2; o += size / 2) {
      if (slopeUp) { ctx.moveTo(o, size); ctx.lineTo(o + size, 0); }
      else { ctx.moveTo(o, 0); ctx.lineTo(o + size, size); }
    }
    ctx.stroke();
  };
  if (kind === 'diagonal') lines(true);
  else if (kind === 'crosshatch') { lines(true); lines(false); }
  else if (kind === 'dots') {
    const r = size * 0.13;
    [[size / 4, size / 4], [3 * size / 4, 3 * size / 4], [3 * size / 4, size / 4], [size / 4, 3 * size / 4]]
      .forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); });
  }
  return ctx.getImageData(0, 0, size, size);
}

function patternName(kind, color) {
  return `pat-${kind}-${color.replace('#', '')}`;
}

// Ensure a tinted pattern image is registered on the map; return its name.
function ensurePattern(map, kind, color) {
  const name = patternName(kind, color);
  if (!map.hasImage(name)) {
    map.addImage(name, makePatternImage(kind, color), { pixelRatio: 2 });
  }
  return name;
}

// Set (or clear) a polygon layer's cross-hatch overlay. kind: none|diagonal|crosshatch|dots.
export function setLayerPattern(map, cfg, kind) {
  cfg.pattern = kind;
  if (cfg.geometry !== 'polygon') return;
  const id = `${cfg.id}-pattern`;
  if (!kind || kind === 'none') {
    if (map.getLayer(id)) map.removeLayer(id);
    return;
  }
  const color = cfg.patternColor || accentColor(cfg);
  const name = ensurePattern(map, kind, color);
  if (map.getLayer(id)) {
    map.setPaintProperty(id, 'fill-pattern', name);
  } else {
    const fillId = `${cfg.id}-fill`;
    const vis = map.getLayer(fillId) ? (map.getLayoutProperty(fillId, 'visibility') || 'visible') : 'visible';
    map.addLayer({
      id,
      type: 'fill',
      source: `src-${cfg.id}`,
      paint: { 'fill-pattern': name, 'fill-opacity': cfg.patternOpacity != null ? cfg.patternOpacity : 1 },
      layout: { visibility: vis }
    });
  }
}

// Change a layer's primary color (choropleth => outline; else fill/circle/line).
export function setLayerColor(map, cfg, color) {
  cfg.patternColor = color;
  cfg.paint = cfg.paint || {};
  if (cfg.choropleth) {
    cfg.paint['line-color'] = color;
    if (map.getLayer(`${cfg.id}-line`)) map.setPaintProperty(`${cfg.id}-line`, 'line-color', choroplethLineColor(cfg, color));
  } else if (cfg.geometry === 'point') {
    cfg.paint['circle-color'] = color;
    if (map.getLayer(`${cfg.id}-circle`)) map.setPaintProperty(`${cfg.id}-circle`, 'circle-color', color);
    if (cfg.legend && cfg.legend[0]) cfg.legend[0].color = color;
  } else if (cfg.geometry === 'line') {
    cfg.paint['line-color'] = color;
    if (map.getLayer(`${cfg.id}-line`)) map.setPaintProperty(`${cfg.id}-line`, 'line-color', color);
    if (cfg.legend && cfg.legend[0]) cfg.legend[0].color = color;
  } else {
    cfg.paint['fill-color'] = color;
    if (map.getLayer(`${cfg.id}-fill`)) map.setPaintProperty(`${cfg.id}-fill`, 'fill-color', color);
    if (cfg.legend && cfg.legend[0]) cfg.legend[0].color = color;
  }
  // Recolor an active pattern to match.
  if (cfg.pattern && cfg.pattern !== 'none') setLayerPattern(map, cfg, cfg.pattern);
}

// Apply a preset color ramp to a choropleth layer (keeps the numeric stop values).
export function setLayerRamp(map, cfg, rampName) {
  if (!cfg.choropleth) return;
  const ramp = RAMPS[rampName];
  if (!ramp) return;
  cfg.ramp = rampName;
  // Sample the ramp to however many classes the layer currently has.
  const cols = sampleRamp(ramp.colors, cfg.choropleth.stops.length);
  cfg.choropleth.stops.forEach((s, i) => { if (cols[i]) s.color = cols[i]; });
  if (map.getLayer(`${cfg.id}-fill`)) {
    map.setPaintProperty(`${cfg.id}-fill`, 'fill-color', choroplethExpr(cfg.choropleth));
  }
  // Keep legend swatches in sync (legend order matches stop order).
  if (cfg.legend) cfg.legend.forEach((e, i) => { if (cfg.choropleth.stops[i]) e.color = cfg.choropleth.stops[i].color; });
  // Refresh accent-derived outline unless the user set an explicit color.
  const p = cfg.paint || {};
  const generic = !p['line-color'] || ['#666', '#666666', '#555555'].includes(p['line-color']);
  if (generic && map.getLayer(`${cfg.id}-line`)) {
    map.setPaintProperty(`${cfg.id}-line`, 'line-color', choroplethLineColor(cfg, accentColor(cfg)));
  }
  // Refresh an active pattern that follows the accent.
  if (cfg.pattern && cfg.pattern !== 'none' && !cfg.patternColor) setLayerPattern(map, cfg, cfg.pattern);
}

// ---- Dynamic indicator layers (data-driven Reporting Level / Display / Year) ----

// Parse a SAVI display string ("1,234", "5.97%", "12.3") into a number.
function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[,%\s$]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n) {
  if (n == null) return '';
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US')
    : (Math.round(n * 100) / 100).toString();
}

// ---- Color interpolation so ramps (5-color) can supply any class count ----
function hexToRgb(h) {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function rgbToHex(r) {
  return '#' + r.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function lerpColor(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  return rgbToHex(ca.map((v, i) => v + (cb[i] - v) * t));
}
// Sample n evenly-spaced colors from a ramp's color list.
export function sampleRamp(colors, n) {
  if (n <= 1) return [colors[colors.length - 1]];
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = (i / (n - 1)) * (colors.length - 1);
    const lo = Math.floor(p), hi = Math.min(colors.length - 1, lo + 1);
    out.push(lerpColor(colors[lo], colors[hi], p - lo));
  }
  return out;
}

// ---- Break algorithms (all return n+1 ascending edge values) ----
function quantileBreaks(xs, n) {
  const q = p => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))];
  const out = [];
  for (let i = 0; i <= n; i++) out.push(q(i / n));
  return out;
}
function equalBreaks(xs, n) {
  const lo = xs[0], hi = xs[xs.length - 1], step = (hi - lo) / n;
  const out = [];
  for (let i = 0; i <= n; i++) out.push(lo + step * i);
  return out;
}
// Jenks natural breaks (Fisher-Jenks). xs must be sorted ascending.
function jenksBreaks(xs, n) {
  const m = xs.length;
  if (m <= n) return quantileBreaks(xs, n);
  const mat1 = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  const mat2 = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(Infinity));
  for (let j = 1; j <= n; j++) { mat1[0][j] = 1; mat1[1][j] = 1; mat2[1][j] = 0; }
  for (let l = 2; l <= m; l++) {
    let s1 = 0, s2 = 0, w = 0;
    for (let mm = 1; mm <= l; mm++) {
      const i3 = l - mm + 1;
      const val = xs[i3 - 1];
      w++; s1 += val; s2 += val * val;
      const variance = s2 - (s1 * s1) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= n; j++) {
          if (mat2[l][j] >= variance + mat2[i4][j - 1]) {
            mat1[l][j] = i3;
            mat2[l][j] = variance + mat2[i4][j - 1];
          }
        }
      }
    }
    mat1[l][1] = 1; mat2[l][1] = s2 - (s1 * s1) / w;
  }
  const kclass = new Array(n + 1);
  kclass[n] = xs[m - 1];
  kclass[0] = xs[0];
  let k = m;
  for (let j = n; j >= 2; j--) {
    const id = mat1[k][j] - 2;
    kclass[j - 1] = xs[id];
    k = mat1[k][j] - 1;
  }
  return kclass;
}

// Ascending class breaks mapped to ramp colors. opts = { method, classes }.
// method: 'quantile' (default) | 'equal' | 'jenks'. classes: 3..7 (default 5).
export function computeStops(values, rampColors, opts) {
  const method = (opts && opts.method) || 'quantile';
  const n = Math.max(2, Math.min(9, (opts && opts.classes) || 5));
  const xs = values.filter(v => v != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  let edges;
  if (method === 'equal') edges = equalBreaks(xs, n);
  else if (method === 'jenks') edges = jenksBreaks(xs, n);
  else edges = quantileBreaks(xs, n);
  // Choropleth interpolate uses the UPPER edge of each class as its stop value.
  const breaks = edges.slice(1);
  for (let i = 1; i < breaks.length; i++) if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 1e-6;
  const colors = sampleRamp(rampColors, breaks.length);
  return breaks.map((value, i) => ({ value, color: colors[i] || colors[colors.length - 1] }));
}

// Recompute a choropleth layer's stops using a new classification (method/classes),
// reusing the already-joined source data. Mutates cfg + updates the map paint/legend.
export function reclassify(map, cfg) {
  if (!cfg.choropleth || !cfg.sourceData) return;
  const rampColors = RAMPS[cfg.ramp || 'warm'].colors;
  const stops = computeStops(
    cfg.sourceData.features.map(f => f.properties.value), rampColors, cfg.classify);
  if (!stops) return;
  cfg.choropleth.stops = stops;
  cfg.legend = stopsLegend(stops);
  if (map && map.getLayer(`${cfg.id}-fill`)) {
    map.setPaintProperty(`${cfg.id}-fill`, 'fill-color', choroplethExpr(cfg.choropleth));
    const p = cfg.paint || {};
    const generic = !p['line-color'] || ['#666', '#666666', '#555555'].includes(p['line-color']);
    if (generic && map.getLayer(`${cfg.id}-line`)) {
      map.setPaintProperty(`${cfg.id}-line`, 'line-color', choroplethLineColor(cfg, accentColor(cfg)));
    }
  }
}

// Build an in-memory FeatureCollection by joining a value map onto geometry.
// Each feature gets: value (numeric, drives choropleth), value_f (formatted, for popups), name.
export function buildIndicatorSourceData(geojson, valueMap, idProp, nameProp) {
  return {
    type: 'FeatureCollection',
    features: geojson.features.map(f => {
      const gid = f.properties[idProp];
      const raw = valueMap[gid];
      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          id: gid,
          name: f.properties[nameProp],
          value: toNum(raw),
          value_f: raw != null ? String(raw) : ''
        }
      };
    })
  };
}

// Build the legend entries from choropleth stops.
function stopsLegend(stops) {
  return stops.map((s, k) => ({
    type: 'polygon', color: s.color,
    label: k === 0 ? `\u2264 ${fmtNum(s.value)}` : `${fmtNum(stops[k - 1].value)}\u2013${fmtNum(s.value)}`
  }));
}

// (Re)compute a dynamic indicator layer's choropleth from a value map and push it to the map.
// meta = { level, display, year, geojson, valueMap, idProp, nameProp }. Mutates cfg.
export function applyIndicatorSelection(map, cfg, meta) {
  cfg.level = meta.level;
  cfg.display = meta.display;
  cfg.year = meta.year;

  const data = buildIndicatorSourceData(meta.geojson, meta.valueMap, meta.idProp, meta.nameProp);
  cfg.sourceData = data;

  const rampColors = RAMPS[cfg.ramp || 'warm'].colors;
  const stops = computeStops(data.features.map(f => f.properties.value), rampColors, cfg.classify)
    || rampColors.map((color, i) => ({ value: i, color }));
  cfg.choropleth = { field: 'value', stops };
  cfg.legend = stopsLegend(stops);
  cfg.popup = {
    title: 'name',
    fields: [{ key: 'value_f', label: `${cfg.label} \u2014 ${meta.display} (${meta.year})` }]
  };

  // map may be null when a layer is prepared before the map/load (seeding, restore).
  if (map) {
    const src = map.getSource(`src-${cfg.id}`);
    if (src) src.setData(data);
    if (map.getLayer(`${cfg.id}-fill`)) {
      map.setPaintProperty(`${cfg.id}-fill`, 'fill-color', choroplethExpr(cfg.choropleth));
    }
    // Keep the accent-derived outline in sync with the (possibly new) ramp, while
    // preserving the transparent-outline-on-no-data rule for choropleth layers.
    const p = cfg.paint || {};
    const generic = !p['line-color'] || ['#666', '#666666', '#555555'].includes(p['line-color']);
    if (generic && map.getLayer(`${cfg.id}-line`)) {
      map.setPaintProperty(`${cfg.id}-line`, 'line-color', choroplethLineColor(cfg, accentColor(cfg)));
    }
  }
}

// Remove a layer's render sub-layers + source entirely.
export function removeLayer(map, cfg) {
  subLayerIds(cfg).forEach(id => { if (map.getLayer(id)) map.removeLayer(id); popupRegistry.delete(id); });
  const sourceId = `src-${cfg.id}`;
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  loadedSources.delete(cfg.id);
}

// Add a layer's source + render layers to the map.
export async function addLayer(map, cfg, visible) {
  const sourceId = `src-${cfg.id}`;
  if (!map.getSource(sourceId)) {
    const data = cfg.sourceData ? cfg.sourceData : await fetch(cfg.source).then(r => r.json());
    map.addSource(sourceId, { type: 'geojson', data });
    loadedSources.add(cfg.id);
  }
  const vis = visible ? 'visible' : 'none';

  if (cfg.geometry === 'polygon') {
    if (!map.getLayer(`${cfg.id}-fill`)) {
      map.addLayer({ id: `${cfg.id}-fill`, type: 'fill', source: sourceId, paint: fillPaint(cfg), layout: { visibility: vis } });
    }
    if (!map.getLayer(`${cfg.id}-line`)) {
      map.addLayer({ id: `${cfg.id}-line`, type: 'line', source: sourceId, paint: linePaint(cfg), layout: { visibility: vis } });
    }
    // Recreate a cross-hatch overlay if one was configured/chosen.
    if (cfg.pattern && cfg.pattern !== 'none') setLayerPattern(map, cfg, cfg.pattern);
  } else if (cfg.geometry === 'point') {
    if (!map.getLayer(`${cfg.id}-circle`)) {
      map.addLayer({ id: `${cfg.id}-circle`, type: 'circle', source: sourceId, paint: circlePaint(cfg), layout: { visibility: vis } });
    }
  } else if (cfg.geometry === 'line') {
    if (!map.getLayer(`${cfg.id}-line`)) {
      map.addLayer({ id: `${cfg.id}-line`, type: 'line', source: sourceId, paint: linePaint(cfg), layout: { visibility: vis } });
    }
  }
}

export function updateLayerVisibility(map, cfg, visible) {
  const vis = visible ? 'visible' : 'none';
  subLayerIds(cfg).forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  });
}

// Live opacity update across the layer's render sub-layers.
export function updateLayerOpacity(map, cfg, value) {
  cfg.opacity = value;
  if (cfg.geometry === 'polygon') {
    if (map.getLayer(`${cfg.id}-fill`)) {
      const base = cfg.choropleth ? 1 : (cfg.paint && cfg.paint['fill-opacity'] != null ? cfg.paint['fill-opacity'] : 0.4);
      map.setPaintProperty(`${cfg.id}-fill`, 'fill-opacity', base * value);
    }
    if (map.getLayer(`${cfg.id}-line`)) {
      map.setPaintProperty(`${cfg.id}-line`, 'line-opacity', value);
    }
  } else if (cfg.geometry === 'point') {
    if (map.getLayer(`${cfg.id}-circle`)) {
      map.setPaintProperty(`${cfg.id}-circle`, 'circle-opacity', value);
      map.setPaintProperty(`${cfg.id}-circle`, 'circle-stroke-opacity', value);
    }
  } else if (cfg.geometry === 'line') {
    if (map.getLayer(`${cfg.id}-line`)) {
      map.setPaintProperty(`${cfg.id}-line`, 'line-opacity', value);
    }
  }
}

// Independent opacity for the cross-hatch overlay, decoupled from the layer's fill opacity.
export function setLayerPatternOpacity(map, cfg, value) {
  cfg.patternOpacity = value;
  if (cfg.geometry !== 'polygon') return;
  if (map.getLayer(`${cfg.id}-pattern`)) {
    map.setPaintProperty(`${cfg.id}-pattern`, 'fill-opacity', value);
  }
}

// After a basemap style swap, re-add all data layers.
export async function reAddAllLayers(map, layerCfgs, activeLayerIds) {
  loadedSources.clear();
  for (const cfg of layerCfgs) {
    await addLayer(map, cfg, activeLayerIds.has(cfg.id));
  }
}

// ---- Popups ----
const fmt = {
  number: v => Number(v).toLocaleString('en-US'),
  currency: v => '$' + Number(v).toLocaleString('en-US'),
  percent: v => Number(v) + '%'
};

// One layer's fields (no title) — a section within the consolidated popup.
function fieldsHtml(cfg, props) {
  const p = cfg.popup;
  let html = '';
  (p.fields || []).forEach(f => {
    let val = props[f.key];
    if (val == null || val === '') return;
    if (f.format && fmt[f.format]) val = fmt[f.format](val);
    html += `<div class="savi-popup-field"><span class="k">${escapeHtml(f.label)}:</span><span class="v">${escapeHtml(String(val))}</span></div>`;
  });
  return html;
}

// Compact tooltip: geography name + its primary (first) value, for hover.
function hoverHtml(cfg, props) {
  const p = cfg.popup;
  const title = p && p.title != null && props[p.title] != null ? props[p.title] : '';
  const f = p && p.fields && p.fields[0];
  let val = f ? props[f.key] : '';
  if (f && f.format && fmt[f.format] && val != null && val !== '') val = fmt[f.format](val);
  let html = `<div class="savi-tip-title">${escapeHtml(title)}</div>`;
  if (val != null && val !== '') html += `<div class="savi-tip-value">${escapeHtml(String(val))}</div>`;
  return html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A single shared hover tooltip + a registry mapping each interactive sublayer
// id to its cfg. Global click/hover handlers are bound once per map; they query
// ALL registered layers at the pointer so overlapping layers produce ONE popup.
// onEnrich is kept module-level so the latest callback always wins.
let hoverTip = null;
const popupRegistry = new Map();  // sublayer id -> cfg
const boundMaps = new WeakSet();
let popupEnrich = null;
let popupActions = null;   // (cfg, props) -> [{ label, onClick }] rendered as popup buttons
let popupPinClick = null;  // (cfg, props, lngLat) -> void : open the editable pin window

// Register popup/hover behavior for the given layers. Safe to call repeatedly
// (new layers, basemap swaps): it just refreshes the registry and binds the
// two global handlers once.
export function bindPopups(map, layerCfgs, opts = {}) {
  if (opts.onEnrich !== undefined) popupEnrich = opts.onEnrich;
  if (opts.actions !== undefined) popupActions = opts.actions;
  if (opts.onPinClick !== undefined) popupPinClick = opts.onPinClick;
  layerCfgs.forEach(cfg => {
    if (!cfg.popup) return;
    const id = cfg.geometry === 'point' ? `${cfg.id}-circle` : `${cfg.id}-fill`;
    popupRegistry.set(id, cfg);
  });

  if (!hoverTip) {
    hoverTip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'savi-hover-tip', offset: 12 });
  }
  if (boundMaps.has(map)) return;
  boundMaps.add(map);

  // Only query layers that currently exist on the map (a layer may be removed,
  // or a basemap swap may be mid-rebuild). Topmost drawn feature comes first.
  const liveLayers = () => [...popupRegistry.keys()].filter(id => map.getLayer(id));
  const pinLayerIds = () => [...popupRegistry.entries()]
    .filter(([id, cfg]) => cfg.kind === 'pins' && map.getLayer(id))
    .map(([id]) => id);
  const pointLayerIds = () => [...popupRegistry.entries()]
    .filter(([id, cfg]) => cfg.geometry === 'point' && cfg.kind !== 'pins' && map.getLayer(id))
    .map(([id]) => id);
  const matchesAt = (point) => {
    // Pins first: query a small padded box so near-clicks still register on the
    // small dot, and ISOLATE to the pin — never surface the underlying geography
    // (that's why clicking near a pin used to show e.g. "Counties").
    const pids = pinLayerIds();
    if (pids.length) {
      const pad = 8;
      const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
      const pinFeats = map.queryRenderedFeatures(box, { layers: pids });
      if (pinFeats.length) {
        const f = pinFeats[0];   // topmost pin wins
        return [{ cfg: popupRegistry.get(f.layer.id), props: f.properties, isPin: true }];
      }
    }
    // Site/asset POINTS next: also small targets. ISOLATE to the clicked point so
    // its own name/fields fill the popup — otherwise the geography polygon beneath
    // (e.g. a county) would win the window title and the point's name would be lost.
    const ptIds = pointLayerIds();
    if (ptIds.length) {
      const pad = 6;
      const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
      const ptFeats = map.queryRenderedFeatures(box, { layers: ptIds });
      if (ptFeats.length) {
        const seen = new Set();
        const out = [];
        ptFeats.forEach(f => {
          const cfg = popupRegistry.get(f.layer.id);
          if (!cfg || seen.has(cfg.id)) return;   // one section per point layer
          seen.add(cfg.id);
          out.push({ cfg, props: f.properties });
        });
        return out;
      }
    }
    const ids = liveLayers();
    if (!ids.length) return [];
    const feats = map.queryRenderedFeatures(point, { layers: ids });
    const seen = new Set();
    const out = [];
    feats.forEach(f => {
      const cfg = popupRegistry.get(f.layer.id);
      if (!cfg || cfg.kind === 'pins' || seen.has(cfg.id)) return;   // pins handled above; one section per layer
      seen.add(cfg.id);
      out.push({ cfg, props: f.properties });
    });
    return out;
  };

  map.on('mousemove', (e) => {
    const matches = matchesAt(e.point);
    if (!matches.length) { map.getCanvas().style.cursor = ''; hoverTip.remove(); return; }
    map.getCanvas().style.cursor = 'pointer';
    hoverTip.setLngLat(e.lngLat).setHTML(hoverHtml(matches[0].cfg, matches[0].props)).addTo(map);
  });

  map.on('click', (e) => {
    // Ignore clicks that originate on a MapLibre marker (e.g. the search pin).
    // Markers live in the canvas container, so maplibre fires the map 'click' for
    // them too; without this guard a pin click would ALSO open the geography info
    // window on top of the marker's own popup. maplibre still toggles the marker's
    // popup itself, so the pin keeps its "Save as pin" window.
    const origin = e.originalEvent && e.originalEvent.target;
    if (origin && origin.closest && origin.closest('.maplibregl-marker')) return;

    const matches = matchesAt(e.point);
    if (!matches.length) { closeInfoWindow(); return; }   // click on empty map dismisses
    hoverTip.remove();

    // A pin click opens the dedicated, editable pin window (name + custom data).
    if (matches[0].isPin && popupPinClick) {
      closeInfoWindow();
      popupPinClick(matches[0].cfg, matches[0].props, e.lngLat);
      return;
    }

    const name = matches[0].props[matches[0].cfg.popup.title];
    let body = '';
    matches.forEach((m, k) => {
      body += `<div class="savi-popup-section">`;
      // When several layers are stacked here, each section names its own layer AND
      // its own feature (geography/point name) — otherwise only the window's single
      // title (matches[0]) is named and every other layer's name is lost.
      if (matches.length > 1) {
        body += `<div class="savi-popup-layer">${escapeHtml(m.cfg.label)}</div>`;
        const secName = m.props[m.cfg.popup.title];
        if (secName != null && secName !== '')
          body += `<div class="savi-popup-name">${escapeHtml(String(secName))}</div>`;
      }
      body += fieldsHtml(m.cfg, m.props);
      body += `<div class="savi-popup-trend" data-idx="${k}" data-loading="1"></div>`;
      if (popupActions) body += `<div class="savi-popup-actions" data-idx="${k}"></div>`;
      body += `</div>`;
    });

    // Show the geography type (e.g. "Counties") from the first layer that carries one.
    const typeMatch = matches.find(m => m.cfg.level);
    const geoType = typeMatch ? typeMatch.cfg.level : '';

    const oe = e.originalEvent;
    const win = openInfoWindow(name != null ? name : '', geoType, body, oe ? oe.clientX : 0, oe ? oe.clientY : 0);

    if (popupActions) renderPopupActions(win, matches);

    if (popupEnrich) {
      matches.forEach((m, k) => {
        Promise.resolve(popupEnrich(m.cfg, m.props)).then(extra => {
          if (!win.isConnected) return;   // window already closed
          const slot = win.querySelector(`.savi-popup-trend[data-idx="${k}"]`);
          if (!slot) return;
          if (extra) { slot.innerHTML = extra; slot.removeAttribute('data-loading'); }
          else slot.remove();
        }).catch(() => {});
      });
    }
  });
}

// Render per-section action buttons (e.g. Add to compare) into the open popup, and
// re-render after a click so toggle labels stay in sync with app state.
function renderPopupActions(win, matches) {
  matches.forEach((m, k) => {
    const slot = win.querySelector(`.savi-popup-actions[data-idx="${k}"]`);
    if (!slot) return;
    const acts = popupActions(m.cfg, m.props) || [];
    slot.innerHTML = '';
    acts.forEach(a => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'savi-popup-action' + (a.active ? ' is-active' : '');
      b.textContent = a.label;
      b.addEventListener('click', () => { a.onClick(); renderPopupActions(win, matches); });
      slot.appendChild(b);
    });
  });
}

// ---- Draggable info window (the geography popup) ----
// A single floating window (not tied to the map's lnglat, so it can be dragged
// freely). Close X sits on the far RIGHT of its header (consistent with the
// floating panels); the header is the drag handle. Only one is open at a time.
let infoWin = null;

function openInfoWindow(title, geoType, bodyHtml, clientX, clientY) {
  closeInfoWindow();
  const win = document.createElement('div');
  win.className = 'savi-info-window';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label',
    (title || 'Geography details') + (geoType ? ` (${geoType})` : ''));

  const header = document.createElement('div');
  header.className = 'savi-info-header';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'savi-info-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '\u00d7';
  // Title block: geography name, with the geography type as a subtitle beneath it.
  const titleBlock = document.createElement('div');
  titleBlock.className = 'savi-info-titleblock';
  const ttl = document.createElement('div');
  ttl.className = 'savi-info-title';
  ttl.textContent = title || '';
  titleBlock.appendChild(ttl);
  if (geoType) {
    const sub = document.createElement('div');
    sub.className = 'savi-info-type';
    sub.textContent = geoType;
    titleBlock.appendChild(sub);
  }
  header.append(titleBlock, close);   // title left, close X far right (matches panels)

  const body = document.createElement('div');
  body.className = 'savi-info-body';
  body.innerHTML = bodyHtml;

  win.append(header, body);
  document.body.appendChild(win);

  // Initial placement near the click, clamped to the viewport.
  const w = win.offsetWidth, h = win.offsetHeight;
  let left = (clientX || 0) + 12, top = (clientY || 0) + 12;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  win.style.left = left + 'px';
  win.style.top = top + 'px';

  close.addEventListener('click', closeInfoWindow);
  makeDraggable(win, header);
  infoWin = win;
  return win;
}

function closeInfoWindow() {
  if (infoWin) { infoWin.remove(); infoWin = null; }
}

// Escape closes the info window.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && infoWin) closeInfoWindow();
});
