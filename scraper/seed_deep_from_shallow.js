#!/usr/bin/env node
// Seed the FULL deep-harvest state from the BROAD (shallow) run so the deep run
// does NOT re-scrape cells the broad run already captured.
//
// Why this is safe:
//  - Cell keys are config-independent: `${groupKey}|c${ci}|${level}|${display}|${year}`
//    (harvest.js uses the RESOLVED display/year, not the "first"/"latest" scope
//    hint), so a cell captured by the broad run has the exact same key in the deep
//    run and will be skipped by the resume check (harvest.js: `if (state.done[...])`).
//  - Only SUCCESSFUL cells are in `done`. Failed cells ("no grid captured") are NOT
//    recorded, so the deep run will still retry them — no permanent gaps.
//  - We copy ONLY `done` (per-cell), never `chunkDone`. Copying chunkDone would make
//    the deep run skip whole chunks and miss the other displays/years it must add.
//
// Idempotent: re-running just re-copies the same keys. A timestamped backup of the
// deep state is written before saving.

const fs = require('fs');

const DEEP = 'output/harvest_state.json';
const SHALLOW = 'output/shallow_state.json';

function load(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

const shallow = load(SHALLOW, null);
if (!shallow || !shallow.done) {
  console.error(`No usable broad state at ${SHALLOW} — nothing to seed.`);
  process.exit(1);
}
const deep = load(DEEP, { startedAt: new Date().toISOString(), done: {}, chunkDone: {}, stats: { records: 0, tables: 0, errors: 0 } });
deep.done = deep.done || {};

const shallowKeys = Object.keys(shallow.done);
let added = 0;
for (const k of shallowKeys) {
  if (!deep.done[k]) { deep.done[k] = true; added++; }
}

// Backup the deep state before overwriting.
if (fs.existsSync(DEEP)) {
  fs.copyFileSync(DEEP, `${DEEP}.bak.${Date.now()}`);
}
fs.writeFileSync(DEEP, JSON.stringify(deep, null, 2));

console.log(`Seeded deep state from broad run:`);
console.log(`  broad done cells:      ${shallowKeys.length}`);
console.log(`  newly marked in deep:  ${added}`);
console.log(`  deep done cells total: ${Object.keys(deep.done).length}`);
console.log(`  (chunkDone intentionally NOT copied — deep run re-enters each chunk to add all displays/years)`);
