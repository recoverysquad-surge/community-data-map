// Build map-ready choropleth data from the harvested 211 values.
//
// Joins harvest_data.ndjson to the county polygons and bakes selected indicators in as
// numeric feature properties, so the MapLibre app can render them as choropleths. Also
// registers matching layers in data/layers.json (idempotent: re-running replaces the
// generated 211 layers, so you can refresh the map as more data harvests).
//
// Run:  node build_map_data.js
//
// Edit YEAR / PREFERRED_DISPLAYS / INDICATORS below to change what the map shows.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NDJSON = path.join(__dirname, 'output', 'harvest_data.ndjson');
const COUNTIES = path.join(ROOT, 'data', 'counties.geojson');
const OUT_GEO = path.join(ROOT, 'data', 'savi_211_counties.geojson');
const LAYERS_JSON = path.join(ROOT, 'data', 'layers.json');
const GEN_TAG = 'savi211';

// --- what to show ---------------------------------------------------------------------
const YEAR = '2019';
// For each indicator, use the first display (in this order) that has all 11 counties.
// Per-capita rates make far better choropleths than raw counts (Marion County dominates).
const PREFERRED_DISPLAYS = ['per 1000 Population', 'as % of 211 Calls', 'Calls'];
// Curated headline indicators (matched by substring against the indicator label).
const INDICATORS = [
  { id: 'mental_health', label: '211 Calls — Mental Health Issues', match: 'Mental Health Issues' },
  { id: 'substance',     label: '211 Calls — Substance Abuse / Addiction', match: 'Substance Abuse or Other Addiction' },
  { id: 'suicide',       label: '211 Calls — Suicide or Homicide', match: 'Suicide or Homicide' },
  { id: 'homeless',      label: '211 Calls — Homeless or Doubled Up', match: 'Homeless or Doubled up' },
];
// Sequential color ramp (light -> dark).
const RAMP = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'];

function log(m) { console.log(`[build_map_data] ${m}`); }

// Parse a SAVI display string ("1,234", "5.97%", "12.3") into a number.
const toNum = v => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// 5 ascending, strictly-increasing class breaks from the values (quantile-ish).
function stops(values) {
  const xs = values.filter(v => v != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const q = p => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))];
  let breaks = [q(0), q(0.25), q(0.5), q(0.75), q(1)];
  // enforce strictly ascending (interpolate requires it)
  for (let i = 1; i < breaks.length; i++) if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 1e-6;
  return breaks.map((value, i) => ({ value, color: RAMP[i] }));
}

// --- load -----------------------------------------------------------------------------
const recs = fs.readFileSync(NDJSON, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const geo = JSON.parse(fs.readFileSync(COUNTIES, 'utf8'));

// Index: label -> display -> geoId -> raw value  (211 only)
const idx = new Map();
for (const r of recs) {
  if (r.category !== '211 Helpline Calls' || r.year !== YEAR) continue;
  if (!idx.has(r.indicatorLabel)) idx.set(r.indicatorLabel, new Map());
  const byDisp = idx.get(r.indicatorLabel);
  if (!byDisp.has(r.display)) byDisp.set(r.display, new Map());
  byDisp.get(r.display).set(r.geoId, r.value);
}

const geoIds = geo.features.map(f => f.properties.fips);

// Resolve each curated indicator to a concrete (label, display) with full coverage.
const resolved = [];
for (const ind of INDICATORS) {
  const label = [...idx.keys()].find(l => l.includes(ind.match));
  if (!label) { log(`SKIP ${ind.id}: no harvested indicator matches "${ind.match}" for ${YEAR}`); continue; }
  const byDisp = idx.get(label);
  const display = PREFERRED_DISPLAYS.find(d => {
    const m = byDisp.get(d);
    return m && geoIds.every(id => m.has(id));
  });
  if (!display) { log(`SKIP ${ind.id}: no display with all 11 counties for ${YEAR}`); continue; }
  resolved.push({ ...ind, label, display });
  log(`OK   ${ind.id}: "${label}" [${display} / ${YEAR}]`);
}
if (!resolved.length) { log('Nothing resolved — is the harvest far enough along? Aborting.'); process.exit(1); }

// --- bake values into county properties ------------------------------------------------
for (const f of geo.features) {
  const id = f.properties.fips;
  for (const r of resolved) {
    const raw = idx.get(r.label).get(r.display).get(id);
    const num = toNum(raw);
    f.properties[`savi_${r.id}`] = num;          // numeric — drives the choropleth
    f.properties[`savi_${r.id}_f`] = raw != null ? String(raw) : '';  // formatted — for popups
  }
}
fs.writeFileSync(OUT_GEO, JSON.stringify(geo));
log(`Wrote ${path.relative(ROOT, OUT_GEO)} (${geo.features.length} counties, ${resolved.length} indicators).`);

// --- register layers in data/layers.json ----------------------------------------------
const catalog = JSON.parse(fs.readFileSync(LAYERS_JSON, 'utf8'));

// category
if (!catalog.categories.some(c => c.id === 'calls211')) {
  catalog.categories.push({ id: 'calls211', label: '211 Helpline Calls' });
}
// drop previously-generated 211 layers, then re-add fresh ones
catalog.layers = catalog.layers.filter(l => l._generated !== GEN_TAG);

const unit = d => d.startsWith('per 1000') ? ' (per 1,000 pop.)' : d.startsWith('as %') ? ' (% of calls)' : ' (calls)';
resolved.forEach((r, i) => {
  const vals = geo.features.map(f => f.properties[`savi_${r.id}`]);
  const st = stops(vals);
  catalog.layers.push({
    id: `calls211_${r.id}`,
    label: r.label + unit(r.display),
    category: 'calls211',
    source: `data/savi_211_counties.geojson`,
    geometry: 'polygon',
    visible: i === 0,               // show the first one by default
    opacity: 0.8,
    choropleth: { field: `savi_${r.id}`, stops: st },
    paint: { 'line-color': '#666', 'line-width': 0.75 },
    popup: {
      title: 'name',
      fields: [
        { key: `savi_${r.id}_f`, label: `${r.label} — ${YEAR}` },
        { key: 'fips', label: 'FIPS' },
      ],
    },
    legend: st.map((s, k) => ({
      type: 'polygon', color: s.color,
      label: k === 0 ? `≤ ${fmtNum(s.value)}` : `${fmtNum(st[k - 1].value)}–${fmtNum(s.value)}`,
    })),
    _generated: GEN_TAG,
  });
});

function fmtNum(n) {
  if (n == null) return '';
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : (Math.round(n * 100) / 100).toString();
}

fs.writeFileSync(LAYERS_JSON, JSON.stringify(catalog, null, 2) + '\n');
log(`Updated ${path.relative(ROOT, LAYERS_JSON)} with ${resolved.length} choropleth layer(s) under "211 Helpline Calls".`);
