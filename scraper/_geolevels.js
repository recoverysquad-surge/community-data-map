const fs = require('fs');
const readline = require('readline');
const files = [];
for (let i = 0; i < 6; i++) { const f = `output/harvest_data.s${i}.ndjson`; if (fs.existsSync(f)) files.push(f); }
const c = {};
const catByLevel = {};
let pending = files.length;
if (!pending) { console.log('no shard ndjson'); process.exit(0); }
for (const f of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(f) });
  rl.on('line', (l) => {
    if (!l.trim()) return;
    let r; try { r = JSON.parse(l); } catch { return; }
    const lv = r.geographyLevel;
    c[lv] = (c[lv] || 0) + 1;
    const k = lv + '|' + r.category;
    catByLevel[k] = (catByLevel[k] || 0) + 1;
  });
  rl.on('close', () => { if (--pending === 0) done(); });
}
function done() {
  console.log('=== rows by geographyLevel (shard ndjsons) ===');
  for (const k of Object.keys(c).sort()) console.log('  ' + k + ': ' + c[k]);
  console.log('=== category x level ===');
  for (const k of Object.keys(catByLevel).sort()) console.log('  ' + k + ' = ' + catByLevel[k]);
}
