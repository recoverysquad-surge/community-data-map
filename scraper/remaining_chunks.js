// Print remaining chunk count for a harvest config, across the 4 shard state files.
//
//   node remaining_chunks.js [configPath] [shardTotal]
//
// Replicates harvest.js's chunk enumeration (buildGroups + chunk + shard hash) and counts how
// many enumerated chunkKeys are NOT yet in any shard's chunkDone. Prints a single integer so a
// watchdog can test for completion (0 = done). Exit 0 always (prints -1 on error).

const fs = require('fs');
const path = require('path');

try {
  const cfgPath = process.argv[2] || path.join(__dirname, 'harvest.priority.json');
  const total = Number(process.argv[3] || 4);
  const CONFIG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
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

  const N = CONFIG.maxLeavesPerGroup || 8;
  let groups = buildGroups(CATALOG).filter(g => inScope(g, CONFIG.scope));
  if (CONFIG.scope.maxGroups) groups = groups.slice(0, CONFIG.scope.maxGroups);

  const states = [];
  const base = CONFIG.output.state; // e.g. output/harvest_state.json
  for (let i = 0; i < total; i++) {
    const p = path.join(__dirname, base.replace(/\.json$/, `.s${i}.json`));
    try { states.push(JSON.parse(fs.readFileSync(p, 'utf8')).chunkDone || {}); } catch { states.push({}); }
  }

  let remaining = 0;
  for (const target of CONFIG.reportingTargets) {
    for (const g of groups) {
      const gk = g.path.join(GKEY_SEP);
      const nch = Math.ceil(g.labels.length / N);
      for (let ci = 0; ci < nch; ci++) {
        const ck = `${gk}|c${ci}|${target.level}`;
        const sh = hashStr(ck) % total;
        if (!states[sh][ck]) remaining++;
      }
    }
  }
  console.log(remaining);
} catch (e) {
  console.log(-1);
}
