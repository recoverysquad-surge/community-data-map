// Summarize SAMPLE harvest results from the master NDJSON: coverage of the 14 sampled
// crime/human-services indicator groups across all 7 geography types.
const fs = require('fs');
const readline = require('readline');
const GKEY_SEP = ' \u203a ';
const CONFIG = JSON.parse(fs.readFileSync('harvest.sample.json', 'utf8'));
// sampled group paths in NDJSON's ' / ' form
const SAMPLE_PATHS = CONFIG.scope.includePaths.map(p => p.split(GKEY_SEP).join(' / '));
const LEVELS = CONFIG.reportingTargets.map(t => t.geoTypeLabel === 'Counties' && t.level.includes('Metropolitan') ? t.level : t.geoTypeLabel);
// NDJSON geographyLevel uses geoTypeLabel-ish values; collect everything and bucket.

function matchSample(indicatorPath) {
  return SAMPLE_PATHS.some(p => (indicatorPath || '').startsWith(p));
}

const perLevel = {};      // level -> { rows, geos:Set, indicators:Set, cats:Set }
const perCat = {};        // "level|category" -> rows
const sampleVals = {};    // level -> one example row

const rl = readline.createInterface({ input: fs.createReadStream('output/harvest_data.ndjson') });
rl.on('line', (l) => {
  if (!l.trim()) return;
  let r; try { r = JSON.parse(l); } catch { return; }
  if (!matchSample(r.indicatorPath)) return;
  const lv = r.geographyLevel;
  if (!perLevel[lv]) perLevel[lv] = { rows: 0, geos: new Set(), indicators: new Set(), cats: new Set() };
  const o = perLevel[lv];
  o.rows++; o.geos.add(r.geoId); o.indicators.add(r.indicatorLabel); o.cats.add(r.category);
  const ck = lv + '|' + r.category; perCat[ck] = (perCat[ck] || 0) + 1;
  if (!sampleVals[lv]) sampleVals[lv] = r;
});
rl.on('close', () => {
  const order = ['Counties', '2010 Census Tracts', 'ZIP Code Tabulation Areas 2010', 'Townships', '2010 Blockgroups', 'School Corporations', 'Metropolitan Statistical Areas 2013'];
  const seen = Object.keys(perLevel);
  const levels = [...order.filter(l => seen.includes(l)), ...seen.filter(l => !order.includes(l))];
  console.log('');
  console.log('  SAMPLE RESULTS — crime + human-services indicators across geography types');
  console.log('  ' + '='.repeat(74));
  console.log('  Sampled groups: ' + SAMPLE_PATHS.length + ' (Public Safety, Health, Housing, Income, Education, 211 Helpline, Demographics)');
  console.log('');
  console.log('  GEO TYPE'.padEnd(36) + 'rows'.padStart(8) + '  geos'.padStart(7) + '  indics'.padStart(8) + '  cats'.padStart(6));
  console.log('  ' + '-'.repeat(72));
  let anyNew = false;
  for (const lv of levels) {
    const o = perLevel[lv];
    const isVisible = (lv === 'Counties' || lv === '2010 Census Tracts');
    const tag = isVisible ? '' : '  (NEW)';
    if (!isVisible) anyNew = true;
    console.log('  ' + (lv + tag).padEnd(36) + String(o.rows).padStart(6) + String(o.geos.size).padStart(9) + String(o.indicators.size).padStart(8) + String(o.cats.size).padStart(6));
  }
  // geo types with ZERO sample data
  const missing = order.filter(l => !seen.includes(l));
  if (missing.length) {
    console.log('');
    console.log('  NO sample data captured for: ' + missing.join(', '));
  }
  console.log('');
  console.log('  BY CATEGORY × GEO TYPE (rows):');
  const cats = [...new Set(Object.keys(perCat).map(k => k.split('|')[1]))].sort();
  for (const lv of levels) {
    const parts = cats.filter(c => perCat[lv + '|' + c]).map(c => c + '=' + perCat[lv + '|' + c]);
    if (parts.length) console.log('   ' + lv + ': ' + parts.join(', '));
  }
  console.log('');
  console.log('  EXAMPLE ROW PER GEO TYPE:');
  for (const lv of levels) {
    const r = sampleVals[lv];
    console.log('   ' + lv + ': ' + r.indicatorLabel + ' [' + r.display + '/' + r.year + '] ' + r.geoName + ' = ' + r.value);
  }
  console.log('');
});
