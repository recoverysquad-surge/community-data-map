// Build map-ready POINT layers from the harvested Sites/asset points.
//
// Reads output/sites_points.ndjson (from harvest_sites.js) and writes one GeoJSON point
// FeatureCollection per Sites sub-category (path[1], e.g. "Health", "Education") to
// data/savi_sites_<slug>.geojson, then registers a matching point layer in data/layers.json
// under a new "Sites, Programs & Agencies" category.
//
// Idempotent: re-running drops the previously-generated sites layers + files and rebuilds,
// so you can refresh as more points harvest.
//
// Run:  node build_sites_data.js [path/to/sites_points.ndjson]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NDJSON = process.argv[2] || path.join(__dirname, 'output', 'sites_points.ndjson');
const DATA_DIR = path.join(ROOT, 'data');
const LAYERS_JSON = path.join(DATA_DIR, 'layers.json');
const GEN_TAG = 'savisites';
const CAT_ID = 'sites';
const CAT_LABEL = 'Sites, Programs & Agencies';

// Distinct colors per sub-category (cycled if more sub-categories than colors).
const PALETTE = [
  '#e6194B', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6',
  '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324', '#800000', '#808000',
  '#000075', '#a9a9a9',
];

function log(m) { console.log(`[build_sites_data] ${m}`); }
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

if (!fs.existsSync(NDJSON)) { log(`No input: ${NDJSON} — run harvest_sites.js first. Aborting.`); process.exit(1); }

// --- load points -----------------------------------------------------------------------
const recs = fs.readFileSync(NDJSON, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
log(`Loaded ${recs.length} point rows from ${path.relative(ROOT, NDJSON)}.`);

// Sub-category = the 2nd path segment ("Sites, Programs, & Agencies" / <sub> / ...).
// indicatorPath is " / "-joined; derive sub from it.
const subOf = r => {
  const parts = (r.indicatorPath || '').split(' / ');
  return parts[1] || 'Other';
};

// De-dup identical points (same assetId+lat+lng+assetType) that can recur across runs.
const seen = new Set();
const bySub = new Map();
let kept = 0;
for (const r of recs) {
  if (r.lat == null || r.lng == null) continue;
  const k = [r.assetId, r.lat, r.lng, r.assetType].join('\u0001');
  if (seen.has(k)) continue;
  seen.add(k);
  const sub = subOf(r);
  if (!bySub.has(sub)) bySub.set(sub, []);
  bySub.get(sub).push(r);
  kept++;
}
log(`Kept ${kept} unique points across ${bySub.size} sub-categor${bySub.size === 1 ? 'y' : 'ies'}.`);

// --- write one GeoJSON per sub-category + collect layer entries -------------------------
const subs = [...bySub.keys()].sort((a, b) => bySub.get(b).length - bySub.get(a).length);
const newLayers = [];
const writtenFiles = [];
subs.forEach((sub, i) => {
  const rows = bySub.get(sub);
  const fc = {
    type: 'FeatureCollection',
    features: rows.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: {
        name: r.name,
        assetType: r.assetType,
        dataYear: r.dataYear || '',
        assetId: r.assetId,
        subcategory: sub,
        detail: r.assetId ? `https://classic.savi.org/SAVI/PopUps/AssetMoreInfo.aspx?AssetID=${r.assetId}` : '',
      },
    })),
  };
  const slug = slugify(sub);
  const fname = `savi_sites_${slug}.geojson`;
  fs.writeFileSync(path.join(DATA_DIR, fname), JSON.stringify(fc));
  writtenFiles.push(fname);
  const color = PALETTE[i % PALETTE.length];
  newLayers.push({
    id: `sites_${slug}`,
    label: `${sub} (${rows.length})`,
    category: CAT_ID,
    source: `data/${fname}`,
    geometry: 'point',
    visible: false,
    opacity: 0.9,
    paint: {
      'circle-color': color,
      'circle-radius': 4,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#ffffff',
    },
    popup: {
      title: 'name',
      fields: [
        { key: 'assetType', label: 'Type' },
        { key: 'subcategory', label: 'Category' },
        { key: 'dataYear', label: 'Data Year' },
        { key: 'assetId', label: 'Asset ID' },
      ],
    },
    legend: [{ type: 'circle', color, label: sub }],
    _generated: GEN_TAG,
  });
  log(`  ${fname}: ${rows.length} points  [${color}]`);
});

// --- register in data/layers.json ------------------------------------------------------
const catalog = JSON.parse(fs.readFileSync(LAYERS_JSON, 'utf8'));
if (!catalog.categories.some(c => c.id === CAT_ID)) {
  catalog.categories.push({ id: CAT_ID, label: CAT_LABEL });
}
// Drop previously-generated sites layers, then add fresh.
catalog.layers = catalog.layers.filter(l => l._generated !== GEN_TAG);
catalog.layers.push(...newLayers);
fs.writeFileSync(LAYERS_JSON, JSON.stringify(catalog, null, 2) + '\n');
log(`Updated ${path.relative(ROOT, LAYERS_JSON)} with ${newLayers.length} point layer(s) under "${CAT_LABEL}".`);

// --- clean up stale generated files no longer produced ---------------------------------
for (const f of fs.readdirSync(DATA_DIR)) {
  if (/^savi_sites_.*\.geojson$/.test(f) && !writtenFiles.includes(f)) {
    fs.unlinkSync(path.join(DATA_DIR, f));
    log(`  removed stale ${f}`);
  }
}
