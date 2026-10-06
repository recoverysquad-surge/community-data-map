// Build a data-driven dataset for the SAVI map's per-layer Reporting Level / Display /
// Year selectors, from the harvested values.
//
// Emits (sharded so the map loads a light index up front and pulls values on demand):
//   data/savi_index.json      — { levels, categories, indicators[availability] }  (NO values)
//   data/values/<id>.json     — { level -> display -> year -> geoId -> rawValue } per indicator
//   data/geo_counties.geojson — slim county geometry (id, name, geometry) for runtime joins
//
// The map reads savi_index.json to (a) populate cascading dropdowns from what data
// actually exists, then lazily fetches data/values/<id>.json to (b) look up the value for any
// chosen (indicator, level, display, year, geo) combination and recolor the choropleth live.
//
// Run:  node build_savi_dataset.js   (re-run after every harvest to refresh)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Read every harvest output we have: the deep run (comprehensive 211/Counties) AND the broad
// shallow run (all other categories + finer geos). Later files win on duplicate cells, which is
// harmless since duplicate (indicator,level,display,year,geo) rows carry the same value.
const NDJSON_SOURCES = [
  path.join(__dirname, 'output', 'harvest_data.ndjson'),
  path.join(__dirname, 'output', 'shallow_data.ndjson'),
  path.join(__dirname, 'output', 'shallow_s1_data.ndjson'),
  path.join(__dirname, 'output', 'shallow_s2_data.ndjson'),
  path.join(__dirname, 'output', 'shallow_s3_data.ndjson'),
  path.join(__dirname, 'output', 'shallow_s4_data.ndjson'),
  path.join(__dirname, 'output', 'geo3_data.ndjson')
];
const COUNTIES = path.join(ROOT, 'data', 'counties.geojson');
const SCHOOLS = path.join(ROOT, 'data', 'geo_schools.geojson');
const OUT_INDEX = path.join(ROOT, 'data', 'savi_index.json');
const OUT_VALUES_DIR = path.join(ROOT, 'data', 'values');
const OUT_GEO = path.join(ROOT, 'data', 'geo_counties.geojson');

function log(m) { console.log(`[build_savi_dataset] ${m}`); }

// Slugify a label into a stable-ish id.
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

// The reporting-level names as they appear in the harvest -> geometry binding.
// Only levels we actually have geometry + data for are emitted.
const LEVEL_GEO = {
  Counties: { geometry: 'data/geo_counties.geojson', idProp: 'id', nameProp: 'name' },
  '2010 Census Tracts': { geometry: 'data/geo_tracts.geojson', idProp: 'geoId', nameProp: 'name' },
  'ZIP Codes': { geometry: 'data/geo_zcta.geojson', idProp: 'geoId', nameProp: 'name' },
  'ZIP Code Tabulation Areas 2010': { geometry: 'data/geo_zcta.geojson', idProp: 'geoId', nameProp: 'name' },
  'ZIP Code Tabulation Areas 2000': { geometry: 'data/geo_zcta.geojson', idProp: 'geoId', nameProp: 'name' },
  'School Corporations': { geometry: 'data/geo_schools.geojson', idProp: 'geoId', nameProp: 'name' },
  Townships: { geometry: 'data/geo_townships.geojson', idProp: 'geoId', nameProp: 'name' },
  '2010 Blockgroups': { geometry: 'data/geo_blockgroups.geojson', idProp: 'geoId', nameProp: 'name' },
  'Metropolitan Statistical Areas 2013': { geometry: 'data/geo_msa.geojson', idProp: 'geoId', nameProp: 'name' }
};

// School Corporations join by geoId, but the harvest geoId (e.g. 0615) differs from the
// geojson geoId (e.g. 1801740). Match on a normalized name instead, and remap the record's
// geoId to the geojson id (records with no name match are dropped — partial coverage).
function normSchool(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')          // map '&' -> AND before stripping punctuation
    .replace(/[^A-Z0-9 ]+/g, ' ')    // strip remaining punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bM S D\b/g, 'MSD')
    .replace(/\bMT\b/g, 'MOUNT')
    .replace(/\bST\b/g, 'SAINT')
    .replace(/\s+/g, ' ')
    .trim();
}
// Explicit harvest-geoId -> geojson-geoId crosswalk for the school corporations whose names
// don't normalize to a match (Indianapolis "M S D ... Township" vs geojson "... Township
// Metropolitan School District", "Con" vs "Consolidated", word-order diffs, etc.). Verified by
// fuzzy token match against data/geo_schools.geojson. Takes precedence over the name match.
// (Sheridan Community Schools / 3055 has no boundary in the geojson, so it stays dropped.)
const SCHOOL_GEOID_CROSSWALK = {
  '0670': '1800960', // County School Corporation Of Brown County -> Brown County County School Corporation
  '4255': '1807620', // Nineveh-Hensley-Jackson United -> ... United School Corporation
  '5300': '1802640', // M S D Decatur Township -> Decatur Township Metropolitan School District
  '5330': '1805670', // M S D Lawrence Township -> Lawrence Township Metropolitan School District
  '5340': '1808820', // M S D Perry Township -> Perry Township Metropolitan School District
  '5350': '1808910', // M S D Pike Township -> Pike Township Metropolitan School District
  '5360': '1812360', // M S D Warren Township -> Warren Township Metropolitan School District
  '5370': '1812720', // M S D Washington Township -> Washington Township Metropolitan School District
  '5375': '1812810', // M S D Wayne Township -> Wayne Township Metropolitan School District
  '5400': '1810920', // School Town Of Speedway -> Speedway School Town
  '5925': '1806510', // M S D Martinsville Schools -> Martinsville Schools Metropolitan School District
  '5930': '1807140'  // Mooresville Con School Corporation -> Mooresville Consolidated School Corporation
};
const schoolNameToGeoId = {};
if (fs.existsSync(SCHOOLS)) {
  const sj = JSON.parse(fs.readFileSync(SCHOOLS, 'utf8'));
  for (const f of sj.features) {
    const key = normSchool(f.properties.name);
    if (key && !(key in schoolNameToGeoId)) schoolNameToGeoId[key] = String(f.properties.geoId);
  }
}
let schoolMatched = 0, schoolTotal = 0;
const schoolSeen = new Set();

// ---- load harvest ----
const recs = [];
for (const src of NDJSON_SOURCES) {
  if (!fs.existsSync(src)) { log(`(skip ${path.relative(ROOT, src)} — not present)`); continue; }
  const lines = fs.readFileSync(src, 'utf8').trim().split('\n').filter(Boolean);
  let ok = 0;
  for (const l of lines) { try { recs.push(JSON.parse(l)); ok++; } catch {} }
  log(`read ${ok} records from ${path.relative(ROOT, src)}`);
}
log(`total ${recs.length} harvested records`);

// ---- build indicators + availability + values ----
const indById = new Map();          // id -> indicator meta
const labelToId = new Map();        // label -> id (labels are unique in practice)
const catSet = new Map();           // category label -> id
const values = {};                  // id -> level -> display -> year -> geoId -> rawValue

function indicatorId(label) {
  if (labelToId.has(label)) return labelToId.get(label);
  let base = slug(label) || 'indicator';
  let id = base, n = 1;
  while (indById.has(id)) id = `${base}_${++n}`;
  labelToId.set(label, id);
  return id;
}

for (const r of recs) {
  const level = r.geographyLevel;
  if (!LEVEL_GEO[level]) continue;                 // skip levels we can't map yet

  // School Corporations: remap harvest geoId -> geojson geoId by normalized name; drop misses.
  if (level === 'School Corporations') {
    const combo = r.geoId + '|' + r.geoName;
    const mapped = SCHOOL_GEOID_CROSSWALK[r.geoId] || schoolNameToGeoId[normSchool(r.geoName)];
    if (!schoolSeen.has(combo)) { schoolSeen.add(combo); schoolTotal++; if (mapped) schoolMatched++; }
    if (!mapped) continue;
    r.geoId = mapped;
  }

  const id = indicatorId(r.indicatorLabel);

  if (!indById.has(id)) {
    indById.set(id, {
      id,
      label: r.indicatorLabel,
      category: r.category,
      path: r.indicatorPath || r.category,
      availability: {}
    });
    if (!catSet.has(r.category)) catSet.set(r.category, slug(r.category));
  }

  // availability index: level -> display -> Set(years)
  const av = indById.get(id).availability;
  av[level] = av[level] || {};
  av[level][r.display] = av[level][r.display] || new Set();
  av[level][r.display].add(r.year);

  // value lookup
  const V = values[id] = values[id] || {};
  const Vl = V[level] = V[level] || {};
  const Vd = Vl[r.display] = Vl[r.display] || {};
  const Vy = Vd[r.year] = Vd[r.year] || {};
  Vy[r.geoId] = r.value;
}

// Freeze availability Sets -> sorted arrays.
const indicators = [...indById.values()].map(ind => {
  const availability = {};
  Object.keys(ind.availability).sort().forEach(level => {
    availability[level] = {};
    Object.keys(ind.availability[level]).sort().forEach(display => {
      availability[level][display] = [...ind.availability[level][display]].sort();
    });
  });
  return { ...ind, availability };
}).sort((a, b) => a.label.localeCompare(b.label));

const categories = [...catSet.entries()]
  .map(([label, id]) => ({ id, label }))
  .sort((a, b) => a.label.localeCompare(b.label));

// Only emit levels that appear in the data.
const usedLevels = new Set();
recs.forEach(r => { if (LEVEL_GEO[r.geographyLevel]) usedLevels.add(r.geographyLevel); });
const levels = {};
usedLevels.forEach(l => { levels[l] = LEVEL_GEO[l]; });

const index = {
  generatedAt: new Date().toISOString(),
  levels,
  categories,
  indicators
};
fs.writeFileSync(OUT_INDEX, JSON.stringify(index));
log(`wrote ${path.relative(ROOT, OUT_INDEX)} — ${indicators.length} indicators, ${categories.length} categories, levels=[${Object.keys(levels).join(', ')}]`);
log(`school corporations name-matched ${schoolMatched}/${schoolTotal} (unmatched dropped)`);

// ---- per-indicator value shards ----
// Clear stale shards so removed indicators don't leave orphan files behind.
if (fs.existsSync(OUT_VALUES_DIR)) {
  for (const f of fs.readdirSync(OUT_VALUES_DIR)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(OUT_VALUES_DIR, f));
  }
} else {
  fs.mkdirSync(OUT_VALUES_DIR, { recursive: true });
}
let shardCount = 0;
for (const id of Object.keys(values)) {
  fs.writeFileSync(path.join(OUT_VALUES_DIR, `${id}.json`), JSON.stringify(values[id]));
  shardCount++;
}
log(`wrote ${shardCount} value shards to ${path.relative(ROOT, OUT_VALUES_DIR)}/`);

// ---- slim county geometry (id, name, geometry only) ----
const counties = JSON.parse(fs.readFileSync(COUNTIES, 'utf8'));
const slimFeatures = counties.features.map(f => ({
  type: 'Feature',
  properties: { id: f.properties.fips, name: f.properties.name },
  geometry: f.geometry
}));
fs.writeFileSync(OUT_GEO, JSON.stringify({ type: 'FeatureCollection', features: slimFeatures }));
log(`wrote ${path.relative(ROOT, OUT_GEO)} — ${slimFeatures.length} county polygons`);
