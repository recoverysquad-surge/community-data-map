const fs = require('fs');
const f = 'output/allgeo_data.ndjson';
if (!fs.existsSync(f)) { console.log('(no ndjson yet)'); process.exit(0); }
const c = {}, seen = {};
fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).forEach(l => {
  try { const r = JSON.parse(l); c[r.geographyLevel] = (c[r.geographyLevel]||0)+1; if (!seen[r.geographyLevel]) seen[r.geographyLevel] = r.geoId; } catch(e){}
});
console.log('counts', JSON.stringify(c));
console.log('sampleIds', JSON.stringify(seen));
