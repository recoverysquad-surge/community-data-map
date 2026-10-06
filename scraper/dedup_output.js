// SAVI harvest output de-duplicator.
//
// harvest.js is append-only (crash-safe): in 'refresh' sync mode it re-fetches the latest
// years to catch upstream revisions, which appends a fresh row for each re-fetched cell.
// This script collapses the output to ONE row per data point — keeping the most recently
// captured value (max capturedAt) — and rewrites both the NDJSON and CSV in place.
//
// Idempotent: running it on already-clean output changes nothing.
//
// Run:  node dedup_output.js [config.json]   (defaults to harvest.config.json)

const fs = require('fs');
const path = require('path');

const CFG_PATH = process.argv[2] || path.join(__dirname, 'harvest.config.json');
const CONFIG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const OUT = CONFIG.output;

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

// A data point is uniquely identified by indicator + geography + reporting level + display + year.
const keyOf = r => [r.indicatorPath, r.indicatorLabel, r.geographyLevel, r.geoId, r.display, r.year].join('\u0001');

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const CSV_COLS = ['category', 'indicatorLabel', 'indicatorPath', 'geographyLevel', 'geoId', 'geoName', 'display', 'year', 'value', 'capturedAt'];

if (!fs.existsSync(OUT.ndjson)) { log(`No NDJSON at ${OUT.ndjson} — nothing to do.`); process.exit(0); }

const lines = fs.readFileSync(OUT.ndjson, 'utf8').split('\n').filter(Boolean);
const best = new Map();
let bad = 0;
for (const line of lines) {
  let r; try { r = JSON.parse(line); } catch { bad++; continue; }
  const k = keyOf(r);
  const prev = best.get(k);
  // Keep the row with the newest capturedAt (ties: last one wins).
  if (!prev || String(r.capturedAt) >= String(prev.capturedAt)) best.set(k, r);
}

const rows = [...best.values()].sort((a, b) =>
  (a.indicatorPath || '').localeCompare(b.indicatorPath || '') ||
  (a.indicatorLabel || '').localeCompare(b.indicatorLabel || '') ||
  (a.geoId || '').localeCompare(b.geoId || '') ||
  (a.display || '').localeCompare(b.display || '') ||
  Number(a.year) - Number(b.year));

const removed = lines.length - rows.length;
log(`Read ${lines.length} rows (${bad} unparseable) -> ${rows.length} unique; removed ${removed} duplicate/superseded.`);

// Rewrite NDJSON.
fs.writeFileSync(OUT.ndjson, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
// Rewrite CSV.
const csv = [CSV_COLS.join(',')].concat(rows.map(r => CSV_COLS.map(c => csvCell(r[c])).join(','))).join('\n') + '\n';
fs.writeFileSync(OUT.csv, csv);
log(`Rewrote ${OUT.ndjson} and ${OUT.csv}.`);
