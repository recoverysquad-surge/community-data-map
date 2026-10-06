// Reset harvest state for groups whose catalog labels use the "Group: Indicator" colon form.
// Those indicators were silently dropped by the old verbatim column match (grid header uses a
// DASH, year prefix, and unit suffix), so their cells were marked done with 0 records written.
// This clears done/chunkDone for every affected group so a re-run (with the fixed tolerant
// column match in harvest.js) re-captures them. Dedup/resume protect against duplicate scraping.
//
//   node reset_colon_groups.js             # dry run — report only
//   node reset_colon_groups.js --apply     # back up each state file (.bak-<ts>) then rewrite
//
// Operates on the master state + every shard state (harvest_state.s*.json). After --apply,
// DELETE the shard state files so run-parallel.sh reseeds them from the edited master.

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const DIR = __dirname;
const GKEY_SEP = ' \u203a ';

const CATALOG = JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8'));
const leaves = CATALOG.items.filter(i => i.isLeaf && i.checkboxId);

// Affected group = any group (path joined by GKEY_SEP) that contains >=1 colon-form label.
const affected = new Set();
const byCat = {};
for (const l of leaves) {
  if (/:/.test(l.label || '')) {
    const gk = l.path.join(GKEY_SEP);
    if (!affected.has(gk)) { affected.add(gk); const c = l.path[0]; byCat[c] = (byCat[c] || 0) + 1; }
  }
}
console.log('affected groups (contain a colon-form label):', affected.size);
console.log('  by category:', JSON.stringify(byCat));

// master state path from the priority config's output.state
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'harvest.priority.json'), 'utf8'));
const masterState = CFG.output.state;

const stateFiles = [masterState];
for (let i = 0; i < 12; i++) {
  const p = masterState.replace(/\.json$/, `.s${i}.json`);
  if (fs.existsSync(path.join(DIR, p))) stateFiles.push(p);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
let grandDone = 0, grandChunk = 0;
for (const rel of stateFiles) {
  const p = path.join(DIR, rel);
  let st;
  try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { console.log('  skip (unreadable):', rel); continue; }
  const groupOf = k => k.split('|')[0];
  const doneKeys = Object.keys(st.done || {}).filter(k => affected.has(groupOf(k)));
  const chunkKeys = Object.keys(st.chunkDone || {}).filter(k => affected.has(groupOf(k)));
  grandDone += doneKeys.length; grandChunk += chunkKeys.length;
  console.log(`  ${rel}: done ${Object.keys(st.done || {}).length} -> remove ${doneKeys.length} | chunkDone ${Object.keys(st.chunkDone || {}).length} -> remove ${chunkKeys.length}`);
  if (APPLY) {
    fs.copyFileSync(p, p + `.bak-${ts}`);
    for (const k of doneKeys) delete st.done[k];
    for (const k of chunkKeys) delete st.chunkDone[k];
    fs.writeFileSync(p, JSON.stringify(st));
  }
}
console.log(`\nTOTAL to remove across ${stateFiles.length} files: done=${grandDone} chunkDone=${grandChunk}`);
console.log(APPLY ? 'APPLIED (backups written as *.bak-' + ts + ').' : 'DRY RUN — re-run with --apply to write.');
