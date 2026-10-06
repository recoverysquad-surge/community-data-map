// Data-progress reporter for the prioritized SAVI harvest.
//
//   node monitor.js [configPath] [shardTotal]
//
// Prints: prioritized chunk progress per reporting level, live indicator counts vs the catalog
// ceiling per category, and overall remaining work. Reads only on-disk state (shard state files,
// catalog, built data/savi_index.json) — safe to run anytime while harvesting.

const fs = require('fs');
const path = require('path');

const cfgPath = process.argv[2] || path.join(__dirname, 'harvest.priority.json');
const total = Number(process.argv[3] || 4);
const CONFIG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const ROOT = path.join(__dirname, '..');
const GKEY_SEP = ' \u203a ';

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16; return h >>> 0;
}
function buildGroups(c) {
  const leaves = c.items.filter(i => i.isLeaf && i.checkboxId);
  const m = new Map();
  for (const l of leaves) { const k = l.path.join(GKEY_SEP); if (!m.has(k)) m.set(k, { path: l.path, labels: [] }); m.get(k).labels.push(l.label); }
  return [...m.values()];
}
function inScope(g, s) {
  if (s.categories && s.categories.length && !s.categories.includes(g.path[0])) return false;
  if (s.includePaths && s.includePaths.length) { const gk = g.path.join(GKEY_SEP); if (!s.includePaths.some(p => gk.startsWith(p))) return false; }
  return true;
}
function bar(frac, width = 24) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return '[' + '#'.repeat(n) + '-'.repeat(width - n) + ']';
}
function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '—'; }

// ---- shard states ----
const base = CONFIG.output.state;
const chunkDone = [];
const doneMaps = [];
for (let i = 0; i < total; i++) {
  const p = path.join(__dirname, base.replace(/\.json$/, `.s${i}.json`));
  try {
    const st = JSON.parse(fs.readFileSync(p, 'utf8'));
    chunkDone.push(st.chunkDone || {});
    doneMaps.push(st.done || {});
  } catch { chunkDone.push({}); doneMaps.push({}); }
}

// ---- harvested combos (LIVE: grows in real time as each cell completes, independent
// of the build/deploy cycle). done key = `groupKey|cIdx|level|display|year`, so the
// category is the first segment of the groupKey. ----
const harvByCat = {};
let harvTotal = 0;
for (const d of doneMaps) {
  for (const k in d) {
    const cat = k.split('|')[0].split(GKEY_SEP)[0];
    harvByCat[cat] = (harvByCat[cat] || 0) + 1;
    harvTotal++;
  }
}

// ---- chunk progress per level ----
const N = CONFIG.maxLeavesPerGroup || 8;
let groups = buildGroups(CATALOG).filter(g => inScope(g, CONFIG.scope));
const perLevel = {};
let gTot = 0, gDone = 0;
for (const target of CONFIG.reportingTargets) {
  let t = 0, d = 0;
  for (const g of groups) {
    const gk = g.path.join(GKEY_SEP);
    const nch = Math.ceil(g.labels.length / N);
    for (let ci = 0; ci < nch; ci++) {
      const ck = `${gk}|c${ci}|${target.level}`;
      const sh = hashStr(ck) % total;
      t++; if (chunkDone[sh][ck]) d++;
    }
  }
  perLevel[target.level] = { t, d }; gTot += t; gDone += d;
}

// ---- live indicators (built dataset) ----
let live = null;
try { live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'savi_index.json'), 'utf8')); } catch {}
const liveByCat = {};
let liveTotal = 0, haveTract = 0;
if (live) {
  liveTotal = (live.indicators || []).length;
  for (const ind of live.indicators || []) {
    liveByCat[ind.category] = (liveByCat[ind.category] || 0) + 1;
    if ((ind.availability || {})['2010 Census Tracts']) haveTract++;
  }
}
// catalog ceiling per prioritized category
const prioCats = CONFIG.scope.categories && CONFIG.scope.categories.length ? CONFIG.scope.categories : null;
const ceilByCat = {};
for (const g of groups) { const c = g.path[0]; ceilByCat[c] = (ceilByCat[c] || 0) + new Set(g.labels).size; }

// ---- render ----
const now = new Date().toLocaleString('en-US', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
});
console.log(`\n  SAVI HARVEST — ${now}   (config: ${path.basename(cfgPath)})`);
console.log('  ' + '='.repeat(66));
console.log('  CHUNK PROGRESS (prioritized scope)');
for (const tgt of CONFIG.reportingTargets) {
  const { t, d } = perLevel[tgt.level];
  console.log('   ' + tgt.level.padEnd(20) + ' ' + bar(d / t) + ' ' + String(d).padStart(4) + '/' + String(t).padEnd(5) + ' ' + pct(d, t));
}
console.log('   ' + 'TOTAL'.padEnd(20) + ' ' + bar(gDone / gTot) + ' ' + String(gDone).padStart(4) + '/' + String(gTot).padEnd(5) + ' ' + pct(gDone, gTot));
console.log(`   remaining chunks: ${gTot - gDone}`);

console.log(`   harvested combos (live, climbs every refresh): ${harvTotal}`);

console.log('\n  BY CATEGORY   harvested = cells done so far (LIVE);  live/ceiling = labels in');
console.log('                the built dataset (updates only on rebuild + a NEW label)');
if (live) {
  console.log(`   dataset built at: ${live.generatedAt}   total live: ${liveTotal}   levels: ${Object.keys(live.levels || {}).length}`);
}
console.log('      ' + 'category'.padEnd(30) + 'harvested   live / ceiling');
{
  const cats = prioCats || Object.keys(ceilByCat);
  for (const c of cats) {
    const l = liveByCat[c] || 0, cap = ceilByCat[c] || 0;
    console.log('      ' + c.padEnd(30)
      + String(harvByCat[c] || 0).padStart(8) + '   '
      + String(l).padStart(4) + ' / ' + String(cap).padEnd(4) + ' '
      + bar(cap ? l / cap : 0, 12) + ' ' + pct(l, cap));
  }
}
console.log('');
