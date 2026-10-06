// Read-only: check whether harvested geoIds for novel levels match the geojson feature ids.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const NDJSON = path.join(__dirname, 'output', 'harvest_data.ndjson');

const LEVELS_OF_INTEREST = [
  'ZIP Codes', 'ZIP Code Tabulation Areas 2010', 'ZIP Code Tabulation Areas 2000',
  'School Corporations', 'Townships', '2010 Blockgroups',
  'Metropolitan Statistical Areas 2013', 'Metropolitan Statistical Areas 2003',
  '2000 Census Tracts'
];
const GEOJSON = {
  zcta: 'data/geo_zcta.geojson',
  schools: 'data/geo_schools.geojson',
  msa: 'data/geo_msa.geojson',
  townships: 'data/geo_townships.geojson',
  blockgroups: 'data/geo_blockgroups.geojson',
  counties: 'data/geo_counties.geojson',
  tracts: 'data/geo_tracts.geojson'
};

// 1) sample harvest geoIds per level
const perLevel = {};
const lines = fs.readFileSync(NDJSON, 'utf8').split('\n');
for (const l of lines) {
  if (!l.trim()) continue;
  let r; try { r = JSON.parse(l); } catch { continue; }
  if (!LEVELS_OF_INTEREST.includes(r.geographyLevel)) continue;
  const o = perLevel[r.geographyLevel] = perLevel[r.geographyLevel] || { ids: new Set(), sample: [] };
  if (o.ids.size < 2000) o.ids.add(r.geoId);
  if (o.sample.length < 3) o.sample.push({ geoId: r.geoId, geoName: r.geoName });
}
console.log('=== HARVEST levels (sample geoId / geoName) ===');
for (const lv of Object.keys(perLevel)) {
  const o = perLevel[lv];
  console.log(`  ${lv}: ${o.ids.size} distinct geoIds; e.g. ` +
    o.sample.map(s => `${s.geoId}="${s.geoName}"`).join(', '));
}

// 2) geojson property shapes + id sets
console.log('\n=== GEOJSON files (feature count, property keys, sample props) ===');
const geoIdSets = {};
for (const [k, rel] of Object.entries(GEOJSON)) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log(`  ${k}: MISSING ${rel}`); continue; }
  const gj = JSON.parse(fs.readFileSync(p, 'utf8'));
  const feats = gj.features || [];
  const f0 = feats[0] || { properties: {} };
  const keys = Object.keys(f0.properties || {});
  console.log(`  ${k} (${rel}): ${feats.length} features; propKeys=[${keys.join(', ')}]`);
  console.log(`      sample props: ${JSON.stringify(f0.properties)}`);
  // collect candidate id values per property for join testing
  geoIdSets[k] = { feats, keys };
}

// 3) try to find which geojson/property best matches each harvest level's ids
console.log('\n=== JOIN test: best geojson+prop match per harvest level ===');
for (const lv of Object.keys(perLevel)) {
  const ids = perLevel[lv].ids;
  let best = null;
  for (const [k, info] of Object.entries(geoIdSets)) {
    for (const prop of info.keys) {
      let hit = 0, n = 0;
      for (const f of info.feats) {
        const v = f.properties ? f.properties[prop] : undefined;
        if (v == null) continue;
        n++;
      }
      // measure coverage: fraction of harvest ids present in this prop's value set
      const set = new Set(info.feats.map(f => String(f.properties ? f.properties[prop] : '')));
      let match = 0;
      for (const id of ids) if (set.has(String(id))) match++;
      const frac = ids.size ? match / ids.size : 0;
      if (!best || frac > best.frac) best = { k, prop, frac, match, total: ids.size };
    }
  }
  if (best) console.log(`  ${lv}: best = ${best.k}.${best.prop} covers ${best.match}/${best.total} (${(best.frac*100).toFixed(0)}%)`);
}
