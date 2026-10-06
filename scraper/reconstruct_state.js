// One-off recovery: rebuild resume-state (done / chunkDone) in output/harvest_state.json
// from the current master NDJSON, after the merge-shards state-fold bug left master state
// stale (Oct 2) while the data itself (output/harvest_data.ndjson) is current.
//
//   node reconstruct_state.js            # DRY RUN (analyze, write nothing)
//   node reconstruct_state.js --apply    # write output/harvest_state.json (backs up first)
//
// WHY THIS IS SAFE (no re-scrape): each row in the NDJSON means that combo's full grid
// (all geos for that group-chunk + level + display + year) was captured in one table request.
// A combo is atomic: you either get the whole grid or "no grid captured" (0 rows). So any row
// present => that (chunkKey|display|year) combo is DONE and can be skipped on resume.
//
// Mapping (must match harvest.js exactly):
//   groupKey = group.path.join(' \u203a ')          (path = indicator path minus the leaf label)
//   label index within group -> ci = floor(idx / maxLeavesPerGroup)   (catalog order)
//   chunkKey = `${groupKey}|c${ci}|${level}`
//   cellKey  = `${chunkKey}|${display}|${year}`
// level comes from reportingTargets; NDJSON geographyLevel must be mapped to the config level.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const APPLY = process.argv.includes('--apply');
const GKEY_SEP = ' \u203a ';
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'harvest.priority.json'), 'utf8'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const N = CONFIG.maxLeavesPerGroup || 8;
const STATE_PATH = path.join(__dirname, CONFIG.output.state);
const NDJSON_PATH = path.join(__dirname, CONFIG.output.ndjson);

// ---- build catalog groups exactly like harvest.js/monitor.js ----
function buildGroups(c) {
  const leaves = c.items.filter(i => i.isLeaf && i.checkboxId);
  const m = new Map();
  for (const l of leaves) {
    const k = l.path.join(GKEY_SEP);
    if (!m.has(k)) m.set(k, { path: l.path, labels: [] });
    m.get(k).labels.push(l.label);
  }
  return [...m.values()];
}
const groups = buildGroups(CATALOG);

// (groupKey, label) -> ci   AND   groupKey -> total chunk count
const labelToCi = new Map();          // key: `${groupKey}\u0000${label}` -> ci
const groupChunkCount = new Map();    // groupKey -> nChunks
for (const g of groups) {
  const gk = g.path.join(GKEY_SEP);
  groupChunkCount.set(gk, Math.ceil(g.labels.length / N));
  g.labels.forEach((label, idx) => {
    labelToCi.set(`${gk}\u0000${label}`, Math.floor(idx / N));
  });
}

// ---- map NDJSON geographyLevel -> config reporting level ----
// reportingTargets: { level, geoTypeLabel, seedGeoId }. NDJSON rows store geographyLevel.
// Accept a match on either the level string or the geoTypeLabel.
const levelByGeo = new Map();
for (const t of CONFIG.reportingTargets) {
  levelByGeo.set(t.level, t.level);
  if (t.geoTypeLabel) levelByGeo.set(t.geoTypeLabel, t.level);
}

const rl = readline.createInterface({ input: fs.createReadStream(NDJSON_PATH) });
const doneFromData = new Set();
let rows = 0, bad = 0, unmappedLevel = new Map(), unmappedLabel = 0;
const comboGeoCount = new Map();      // cellKey -> set size (how many geos captured)

rl.on('line', (line) => {
  if (!line.trim()) return;
  let r;
  try { r = JSON.parse(line); } catch { bad++; return; }
  rows++;
  const level = levelByGeo.get(r.geographyLevel);
  if (!level) { unmappedLevel.set(r.geographyLevel, (unmappedLevel.get(r.geographyLevel) || 0) + 1); return; }
  const gk = (r.indicatorPath || '').split(' / ').join(GKEY_SEP);
  const ci = labelToCi.get(`${gk}\u0000${r.indicatorLabel}`);
  if (ci === undefined) { unmappedLabel++; return; }
  const cellKey = `${gk}|c${ci}|${level}|${r.display}|${r.year}`;
  doneFromData.add(cellKey);
  const s = comboGeoCount.get(cellKey) || new Set();
  s.add(r.geoId);
  comboGeoCount.set(cellKey, s);
});

rl.on('close', () => {
  // existing (stale but valid) state
  let prev = { startedAt: new Date().toISOString(), done: {}, chunkDone: {}, stats: {} };
  try { prev = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  const prevDone = Object.keys(prev.done || {}).length;
  const prevChunk = Object.keys(prev.chunkDone || {}).length;

  // merge: keep everything already in state, add all cellKeys discovered from data
  const done = Object.assign({}, prev.done || {});
  let added = 0;
  for (const k of doneFromData) if (!done[k]) { done[k] = true; added++; }

  // keep existing chunkDone as-is (genuinely-complete chunks); do NOT fabricate new ones
  const chunkDone = Object.assign({}, prev.chunkDone || {});

  console.log('=== RECONSTRUCTION ANALYSIS ===');
  console.log('NDJSON rows parsed      :', rows, '(bad JSON:', bad + ')');
  console.log('unmapped geographyLevel :', unmappedLevel.size ? [...unmappedLevel.entries()] : 'none');
  console.log('unmapped (group,label)  :', unmappedLabel);
  console.log('distinct done combos    :', doneFromData.size);
  console.log('prev state done / chunk :', prevDone, '/', prevChunk);
  console.log('done after merge        :', Object.keys(done).length, `(+${added} new)`);
  console.log('chunkDone (unchanged)   :', Object.keys(chunkDone).length);
  // geo-count sanity: how many combos have very few geos (possible partials)
  let tiny = 0; for (const s of comboGeoCount.values()) if (s.size <= 2) tiny++;
  console.log('combos with <=2 geos    :', tiny, '(atomic grid => normally all geos; low is fine)');

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply to persist.'); return; }

  const out = Object.assign({}, prev, {
    done,
    chunkDone,
    updatedAt: new Date().toISOString(),
    reconstructedAt: new Date().toISOString(),
    reconstructedFrom: path.basename(NDJSON_PATH),
  });
  const bak = STATE_PATH.replace(/\.json$/, `.bak.${Date.now()}.json`);
  try { fs.copyFileSync(STATE_PATH, bak); console.log('backed up prev state ->', path.basename(bak)); } catch {}
  fs.writeFileSync(STATE_PATH, JSON.stringify(out));
  console.log('WROTE', STATE_PATH, '  done=', Object.keys(done).length, ' chunkDone=', Object.keys(chunkDone).length);
});
