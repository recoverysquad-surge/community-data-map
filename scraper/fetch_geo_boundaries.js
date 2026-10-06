// Multi-level boundary fetcher for the SAVI map (companion to fetch_boundaries.js, which
// does Counties). Pulls polygon geometry for the finer SAVI reporting levels from the US
// Census TIGERweb 2010 vintage service (public, authoritative) as GeoJSON, keyed by GEOID
// so it joins 1:1 to the harvested values (whose geoId == the Census GEOID for these levels).
//
// Service: TIGERweb/tigerWMS_Census2010/MapServer  (2010 vintage == SAVI's *2010 levels)
//   14 Census Tracts | 16 Census Block Groups | 8 ZCTA | 28 County Subdivisions (Townships)
//   20 Unified School Districts
// MSA/CBSA comes from TIGERweb/CBSA/MapServer (current).
//
// Run:  node fetch_geo_boundaries.js <level>
//   where <level> in: tracts | blockgroups | zcta | townships | schools | msa | all
//
// Output: ../data/geo_<level>.geojson  (FeatureCollection; properties {name, geoId}).

const fs = require('fs');
const path = require('path');
const https = require('https');

const GEO = JSON.parse(fs.readFileSync(path.join(__dirname, 'geographies.json'), 'utf8'));
const COUNTIES = GEO.counties.map(c => c.fips);                 // 5-digit state+county
const COUNTY3 = GEO.counties.map(c => c.fips.slice(2));         // 3-digit county code
const DATA = path.join(__dirname, '..', 'data');

const C2010 = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2010/MapServer';
const CBSA = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/CBSA/MapServer';

// Bounding box around the 11-county Central Indiana region (lng/lat, WGS84) for levels
// that carry no STATE/COUNTY attribute (ZCTA). xmin,ymin,xmax,ymax.
const REGION_BBOX = '-87.0,39.1,-85.4,40.4';

// level -> { url, where, outFields, geometry?, out }. Default outFields covers tract/BG/township.
const stateCounty = `STATE='18' AND COUNTY IN (${COUNTY3.map(c => `'${c}'`).join(',')})`;
const DEF_FIELDS = 'GEOID,NAME,BASENAME,STATE,COUNTY';
const LEVELS = {
  tracts:      { url: `${C2010}/14/query`, where: stateCounty, out: 'geo_tracts.geojson' },
  blockgroups: { url: `${C2010}/16/query`, where: stateCounty, out: 'geo_blockgroups.geojson' },
  townships:   { url: `${C2010}/28/query`, where: stateCounty, out: 'geo_townships.geojson' },
  // ZCTA has no STATE/COUNTY field -> select by regional bounding box instead.
  zcta:        { url: `${C2010}/8/query`,  where: '1=1', outFields: 'GEOID,NAME,BASENAME', geometry: REGION_BBOX, out: 'geo_zcta.geojson' },
  // Unified School Districts have STATE but not COUNTY.
  schools:     { url: `${C2010}/20/query`, where: `STATE='18'`, outFields: 'GEOID,NAME,BASENAME,STATE', out: 'geo_schools.geojson' },
  // Metro/Micropolitan Statistical Areas (layer 1); select Indianapolis MSA by name.
  msa:         { url: `${CBSA}/3/query`,   where: `NAME LIKE '%Indianapolis%'`, outFields: 'GEOID,NAME,BASENAME', out: 'geo_msa.geojson' },
};

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let b = ''; res.setEncoding('utf8'); res.on('data', c => (b += c)); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

async function fetchLevel(key) {
  const L = LEVELS[key];
  if (!L) throw new Error(`unknown level ${key}`);
  const params = new URLSearchParams({
    where: L.where,
    outFields: L.outFields || DEF_FIELDS,
    returnGeometry: 'true', outSR: '4326', f: 'geojson',
  });
  if (L.geometry) {
    params.set('geometry', L.geometry);
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }
  log(`${key}: querying TIGERweb…`);
  const fc = JSON.parse(await get(`${L.url}?${params.toString()}`));
  if (fc.type !== 'FeatureCollection') throw new Error(`${key}: unexpected response ${JSON.stringify(fc).slice(0,200)}`);
  const features = fc.features.map(f => {
    const p = f.properties || {};
    return { type: 'Feature', properties: { name: p.NAME || p.BASENAME || String(p.GEOID), geoId: String(p.GEOID) }, geometry: f.geometry };
  });
  fs.writeFileSync(path.join(DATA, L.out), JSON.stringify({ type: 'FeatureCollection', features }));
  log(`${key}: wrote ${features.length} features -> data/${L.out}`);
  log(`${key}: sample ids ${features.slice(0,4).map(f => f.properties.geoId).join(', ')}`);
  return features.length;
}

(async () => {
  const arg = (process.argv[2] || 'tracts').toLowerCase();
  const keys = arg === 'all' ? Object.keys(LEVELS) : [arg];
  for (const k of keys) {
    try { await fetchLevel(k); } catch (e) { log(`${k}: FAILED ${e.message}`); }
  }
})();
