// Post-build sanity check for the SAVI dataset.
//
//   node verify_dataset.js [configPath] [shardTotal]
//
// Catches the "harvested but no data landed" anti-pattern (the colon-vs-dash column-match bug
// that left Public Safety / Housing cells marked done with 0 records written). For each
// category it compares four independent signals:
//   doneCells  — cells the harvest state says are complete (per shard state .done)
//   ndRows     — rows actually written to the harvest NDJSON
//   ndLabels   — DISTINCT indicator labels present in the harvest NDJSON
//   liveInds   — indicators in the built data/savi_index.json
// A healthy done cell is one grid capture writing MANY geo rows, so ndRows should dwarf
// doneCells; `ndRows < doneCells` means cells were ticked without capturing data (WARN
// ticked-without-data — re-run after fixing the column match + resetting those cells).
// Separately, the build should emit ~every captured label; a big ndLabels->liveInds shortfall
// means the build is dropping rows (level not in LEVEL_GEO, geo join miss, etc. — WARN
// build-dropping). Any WARN sets exit code 1. Read-only — safe to run anytime.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const cfgPath = process.argv[2] || path.join(__dirname, 'harvest.priority.json');
const total = Number(process.argv[3] || 6);
const CONFIG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const ROOT = path.join(__dirname, '..');
const GKEY_SEP = ' \u203a ';

// ---- doneCells per category (from shard state) ----
const base = CONFIG.output.state;
const doneByCat = {};
let doneTotal = 0;
for (let i = 0; i < total; i++) {
  const p = path.join(__dirname, base.replace(/\.json$/, `.s${i}.json`));
  let st; try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  for (const k in (st.done || {})) {
    const cat = k.split('|')[0].split(GKEY_SEP)[0];
    doneByCat[cat] = (doneByCat[cat] || 0) + 1;
    doneTotal++;
  }
}

// ---- live indicators per category (built dataset) ----
let live = null;
try { live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'savi_index.json'), 'utf8')); } catch {}
const liveByCat = {};
if (live) for (const ind of live.indicators || []) liveByCat[ind.category] = (liveByCat[ind.category] || 0) + 1;

// ---- distinct NDJSON labels per category (stream all master + shallow sources) ----
const NDJSON_SOURCES = [
  'output/harvest_data.ndjson',
  'output/shallow_data.ndjson',
  'output/shallow_s1_data.ndjson', 'output/shallow_s2_data.ndjson',
  'output/shallow_s3_data.ndjson', 'output/shallow_s4_data.ndjson',
  'output/geo3_data.ndjson'
].map(f => path.join(__dirname, f)).filter(fs.existsSync);

const labelsByCat = {};   // category -> Set(indicatorLabel)
const rowsByCat = {};     // category -> row count
let ndRows = 0;

function streamFile(fp) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: fs.createReadStream(fp) });
    rl.on('line', l => {
      if (!l.trim()) return;
      let o; try { o = JSON.parse(l); } catch { return; }
      ndRows++;
      const cat = o.category || (o.indicatorPath || '').split(' / ')[0] || '(none)';
      (labelsByCat[cat] = labelsByCat[cat] || new Set()).add(o.indicatorLabel);
      rowsByCat[cat] = (rowsByCat[cat] || 0) + 1;
    });
    rl.on('close', resolve);
  });
}

(async () => {
  for (const fp of NDJSON_SOURCES) await streamFile(fp);

  const cats = [...new Set([
    ...Object.keys(doneByCat), ...Object.keys(labelsByCat), ...Object.keys(liveByCat)
  ])].sort();

  console.log(`\n  DATASET VERIFY   (config: ${path.basename(cfgPath)})`);
  console.log('  ' + '='.repeat(70));
  if (live) console.log(`  built at ${live.generatedAt}  |  ${(live.indicators||[]).length} live indicators  |  ${Object.keys(live.levels||{}).length} levels`);
  console.log(`  NDJSON rows scanned: ${ndRows}  |  done-cells: ${doneTotal}\n`);
  console.log('  ' + 'category'.padEnd(32) + 'doneCells   ndRows  ndLabels  liveInds   status');

  const warns = [];
  for (const c of cats) {
    const done = doneByCat[c] || 0;
    const rows = rowsByCat[c] || 0;
    const nd = (labelsByCat[c] || new Set()).size;
    const lv = liveByCat[c] || 0;

    // A healthy done cell = one grid capture writing many geo rows, so rows should dwarf
    // done-cells. The colon-label bug ticked cells done with 0 rows -> rows << done-cells.
    // Separately, the build should emit ~every captured label; a big ndLabels->liveInds
    // shortfall means it's dropping rows (level unmapped, geo join miss, etc.).
    let status = 'ok';
    if (done >= 20 && rows < done) { status = 'WARN ticked-without-data'; warns.push(`${c}: ${done} done-cells but only ${rows} rows captured (cells ticked with no data)`); }
    else if (nd >= 10 && lv < nd * 0.9) { status = 'WARN build-dropping';  warns.push(`${c}: ${nd} captured labels but only ${lv} live indicators (build dropping rows)`); }

    console.log('  ' + c.padEnd(32)
      + String(done).padStart(7) + '  '
      + String(rows).padStart(8) + '  '
      + String(nd).padStart(8) + '  '
      + String(lv).padStart(8) + '   '
      + status);
  }

  console.log('');
  if (warns.length) {
    console.log(`  ${warns.length} WARNING(S):`);
    warns.forEach(w => console.log('   ! ' + w));
    process.exitCode = 1;
  } else {
    console.log('  All categories pass (no data-landing gaps detected).');
  }
  console.log('');
})();
