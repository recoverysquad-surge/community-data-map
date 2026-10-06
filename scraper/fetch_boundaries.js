// SAVI boundary fetcher — county polygons for the map.
//
// The harvester (harvest.js) captures indicator VALUES keyed by a geo id (FIPS), but not
// the SHAPES needed to draw them on a map. This script fetches the matching county polygon
// boundaries from the US Census TIGERweb REST service (public, authoritative) as GeoJSON,
// keyed by the SAME id (`fips` == the harvest's `geoId`) so values can be joined 1:1 to a
// choropleth in the MapLibre app.
//
// Source: TIGERweb "State_County" MapServer, layer 1 = current Counties.
//   https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1
//
// The county list comes from geographies.json (the 11 Central Indiana counties). Output is
// written to ../data/counties.geojson, which data/layers.json already points the map at.
//
// Run:  node fetch_boundaries.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const GEO = JSON.parse(fs.readFileSync(path.join(__dirname, 'geographies.json'), 'utf8'));
const OUT = path.join(__dirname, '..', 'data', 'counties.geojson');
const LAYER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query';

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

// GET a URL and resolve its full body as a string.
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

(async () => {
  const counties = GEO.counties || [];
  if (!counties.length) throw new Error('No counties in geographies.json');

  const inList = counties.map(c => `'${c.fips}'`).join(',');
  const params = new URLSearchParams({
    where: `GEOID IN (${inList})`,
    outFields: 'GEOID,NAME,BASENAME,STATE,COUNTY',
    returnGeometry: 'true',
    outSR: '4326',       // WGS84 lon/lat — what MapLibre expects
    f: 'geojson',
  });
  log(`Fetching ${counties.length} county boundaries from TIGERweb…`);
  const raw = await get(`${LAYER}?${params.toString()}`);
  const fc = JSON.parse(raw);
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Unexpected response (not a GeoJSON FeatureCollection)');
  }

  // Normalize properties: keep the join key as `fips` (== harvest geoId) plus a clean `name`.
  const byFips = new Map(counties.map(c => [c.fips, c.name]));
  const features = fc.features.map(f => {
    const p = f.properties || {};
    const fips = String(p.GEOID);
    const name = byFips.get(fips) || (p.NAME || p.BASENAME || '').replace(/ County$/i, '');
    return {
      type: 'Feature',
      properties: { name, fips, geoId: fips },
      geometry: f.geometry,
    };
  });

  // Report any requested county the service did not return.
  const got = new Set(features.map(f => f.properties.fips));
  const missing = counties.filter(c => !got.has(c.fips)).map(c => `${c.fips} ${c.name}`);
  if (missing.length) log(`WARNING: no geometry for: ${missing.join(', ')}`);

  const out = { type: 'FeatureCollection', features };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  log(`Wrote ${features.length} county polygons -> ${path.relative(path.join(__dirname, '..'), OUT)}`);
})().catch(err => { console.error('FATAL:', err.message); process.exitCode = 1; });
