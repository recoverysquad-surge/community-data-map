// Merge the 4 shallow shard outputs (+ the original single-run output) into one
// output/shallow_data.{ndjson,csv}, de-duplicated.
//
// Each shard worked a DISJOINT set of categories and seeded its state from the single-run
// snapshot, so in practice rows don't overlap — but this merge dedups defensively by the
// same key dedup_output.js uses (indicator + geography + level + display + year), keeping the
// newest capturedAt. Idempotent: safe to re-run as shards finish.
//
// Run:  node merge_shallow.js

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'output');
const MERGED_NDJSON = path.join(OUT_DIR, 'shallow_data.ndjson');
const MERGED_CSV = path.join(OUT_DIR, 'shallow_data.csv');

// Sources: the original single-run file + each shard file. Missing files are skipped.
const SOURCES = [
  path.join(OUT_DIR, 'shallow_data.ndjson'),
  path.join(OUT_DIR, 'shallow_s1_data.ndjson'),
  path.join(OUT_DIR, 'shallow_s2_data.ndjson'),
  path.join(OUT_DIR, 'shallow_s3_data.ndjson'),
  path.join(OUT_DIR, 'shallow_s4_data.ndjson'),
];

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

const keyOf = r => [r.indicatorPath, r.indicatorLabel, r.geographyLevel, r.geoId, r.display, r.year].join('\u0001');
const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const CSV_COLS = ['category', 'indicatorLabel', 'indicatorPath', 'geographyLevel', 'geoId', 'geoName', 'display', 'year', 'value', 'capturedAt'];

const best = new Map();
let total = 0, bad = 0, used = 0;
for (const src of SOURCES) {
  if (!fs.existsSync(src)) { log(`skip (missing): ${path.basename(src)}`); continue; }
  const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
  used++;
  let n = 0;
  for (const line of lines) {
    total++;
    let r; try { r = JSON.parse(line); } catch { bad++; continue; }
    const k = keyOf(r);
    const prev = best.get(k);
    if (!prev || String(r.capturedAt) >= String(prev.capturedAt)) best.set(k, r);
    n++;
  }
  log(`read ${String(n).padStart(7)} rows from ${path.basename(src)}`);
}

const rows = [...best.values()].sort((a, b) =>
  (a.indicatorPath || '').localeCompare(b.indicatorPath || '') ||
  (a.indicatorLabel || '').localeCompare(b.indicatorLabel || '') ||
  (a.geoId || '').localeCompare(b.geoId || '') ||
  (a.display || '').localeCompare(b.display || '') ||
  Number(a.year) - Number(b.year));

log(`merged ${used} file(s): ${total} rows (${bad} unparseable) -> ${rows.length} unique; dropped ${total - bad - rows.length} duplicate/superseded.`);

fs.writeFileSync(MERGED_NDJSON, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const csv = [CSV_COLS.join(',')].concat(rows.map(r => CSV_COLS.map(c => csvCell(r[c])).join(','))).join('\n') + '\n';
fs.writeFileSync(MERGED_CSV, csv);
log(`wrote ${MERGED_NDJSON}`);
log(`wrote ${MERGED_CSV}`);
