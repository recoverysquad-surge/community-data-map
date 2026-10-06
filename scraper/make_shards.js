// Generate 4 shallow-shard configs + seed their state from the single-run snapshot.
// Each shard owns a DISJOINT set of categories (no overlap => no duplicate work).
// Seeding copies done/chunkDone from the snapshot so already-captured cells are skipped;
// stats are zeroed so each shard's log reflects only its own new progress.
//
// Run once:  node make_shards.js
const fs = require('fs');
const path = require('path');

const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'harvest.shallow.json'), 'utf8'));
const snapPath = path.join(__dirname, 'output', 'shallow_state.snapshot.json');
const snap = fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, 'utf8')) : { done: {}, chunkDone: {} };

// Balanced by catalog group-count (Sites is huge => its own worker).
const SHARDS = {
  s1: ['Sites, Programs, & Agencies'],
  s2: ['Housing', 'Economy', 'Transportation and Mobility', 'Political and Administrative Boundaries'],
  s3: ['Health', 'Education', 'Environment'],
  s4: ['Demographics', 'Income', 'Public Safety', 'Arts, Culture and Recreation'],
};

const now = new Date().toISOString();
for (const [id, cats] of Object.entries(SHARDS)) {
  const cfg = JSON.parse(JSON.stringify(base));
  cfg._comment = `SHALLOW SHARD ${id} — categories: ${cats.join('; ')}. Parallel worker; disjoint categories; own output/state so no clobbering. Merge back into shallow_data.* with merge_shallow.js + dedup when all shards finish.`;
  cfg.delayMs = 2000; // bumped from 1500: 4 parallel workers => keep aggregate request rate polite
  cfg.scope.categories = cats;
  cfg.output = {
    ndjson: `output/shallow_${id}_data.ndjson`,
    csv: `output/shallow_${id}_data.csv`,
    state: `output/shallow_${id}_state.json`,
    rawDir: `output/shallow_${id}_raw`,
  };
  const cfgFile = path.join(__dirname, `harvest.shallow.${id}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

  // Seed this shard's state from the snapshot (skip already-done work).
  const statePath = path.join(__dirname, cfg.output.state);
  const seeded = {
    startedAt: now,
    done: { ...(snap.done || {}) },
    chunkDone: { ...(snap.chunkDone || {}) },
    stats: { records: 0, tables: 0, errors: 0 },
    updatedAt: now,
  };
  fs.writeFileSync(statePath, JSON.stringify(seeded, null, 2));
  console.log(`${id}: ${cfgFile}  (categories=${cats.length}, seeded chunkDone=${Object.keys(seeded.chunkDone).length})`);
}
console.log('done.');
