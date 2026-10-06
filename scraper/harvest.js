// SAVI resumable data harvester.
//
// Walks the proven Advanced Search pipeline to pull real indicator VALUES and writes them
// as tidy rows (NDJSON + CSV). It is:
//   - config-driven  (harvest.config.json — scope, reporting levels, politeness)
//   - resumable      (a state file records every completed cell; re-runs skip them)
//   - polite         (a configurable delay between every server interaction)
//
// Unit of work = a "chunk": a set of sibling indicator leaves under one category path,
// selected together so they become COLUMNS of one data grid (rows = geographies). Each
// chunk runs in its OWN fresh browser context (an isolated session => an empty project) so
// selections never accumulate across chunks. For each chunk we configure the per-item
// dropdowns and create one table per (reporting level x display x year) combination,
// capturing and parsing each grid.
//
// Pipeline per chunk:
//   ServiceArea (pick geo type + seed) -> Select Data (ProjectID) -> picker (expand to the
//   category path, tick the leaves) -> commit -> Table.aspx (read per-item itemId + option
//   lists + VULNS instance ids) -> for each combo: set dropdowns, tick VULNS, "create
//   tables" -> capture popups/table.aspx response -> parse the RadGrid -> emit rows.
//
// Run:  see HARVEST.md  (needs a real display for the create-tables RadWindow; headless
//       does not surface it).

const fs = require('fs');
const path = require('path');
const { START, BASE, launch, sleep, setGeographyType, selectAndCommitGeo, gotoSelectData } = require('./lib/flow');
const { expandToPath, tickLeaves, commitSelection } = require('./lib/picker');
const { parseGrid } = require('./lib/grid');

// Match a catalog leaf label to its grid column header. The grid header is NOT the catalog
// label verbatim: it carries a leading year, a different group separator, and a trailing unit
// suffix (e.g. catalog "All Crimes: All Aggravated Assaults for the Year" vs grid column
// "2012 All Crimes- All Aggravated Assaults for the Year Crimes"). Try the fast exact-substring
// path first (unchanged behavior), then fall back to a punctuation-insensitive normalized
// containment so ":"-vs-"-" / year-prefix / unit-suffix differences don't drop the column.
const normLabel = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function findGridColumn(columns, label) {
  let col = columns.find(c => c.includes(label)) ||
            columns.find(c => c.includes(label.slice(0, 40)));
  if (col) return col;
  const nl = normLabel(label);
  if (nl) col = columns.find(c => normLabel(c).includes(nl));
  return col || null;
}

const CFG_PATH = process.argv[2] || path.join(__dirname, 'harvest.config.json');
const CONFIG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));

// Incremental sync policy (how a re-run treats already-harvested work):
//   mode 'resume'  (default) — skip every completed cell AND every completed chunk. Fastest;
//                  only genuinely-new chunks (e.g. new indicators after a catalog refresh)
//                  are harvested. Existing chunks are never revisited.
//   mode 'refresh' — additions + recent revisions. Completed chunks ARE revisited so newly
//                  published years are picked up, and the latest `refreshLatestYears` years
//                  are always re-fetched (to catch upstream restatements). Everything else
//                  already captured is skipped. Re-fetched cells are re-appended with a fresh
//                  capturedAt; run dedup_output.js afterwards to collapse to the latest.
const SYNC = {
  mode: (CONFIG.sync && CONFIG.sync.mode) || 'resume',
  refreshLatestYears: (CONFIG.sync && CONFIG.sync.refreshLatestYears) || 2,
};

// Optional sharding: split the chunk workload deterministically across N parallel workers.
// Each worker runs the SAME config but keeps only the chunks whose key hashes to its index.
// Because the partition is by a stable hash of chunkKey, shards never overlap and together
// cover every chunk — so N isolated-display workers can run concurrently with no coordination.
const SHARD = (CONFIG.shard && CONFIG.shard.total > 1)
  ? { index: CONFIG.shard.index | 0, total: CONFIG.shard.total | 0 }
  : null;

// Small stable string hash (FNV-1a, 32-bit) + a murmur3 avalanche finalizer — deterministic
// across processes/runs. The finalizer is essential: raw FNV-1a low bits distribute poorly
// under `% total`, which would pile most chunks onto one shard.
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }
const GKEY_SEP = ' \u203a '; // "›" — readable group key separator

// ---- output + state ---------------------------------------------------------------------

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { startedAt: new Date().toISOString(), done: {}, chunkDone: {}, stats: { records: 0, tables: 0, errors: 0 } }; }
}
function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const CSV_COLS = ['category', 'indicatorLabel', 'indicatorPath', 'geographyLevel', 'geoId', 'geoName', 'display', 'year', 'value', 'capturedAt'];

function makeWriters(out) {
  ensureDir(path.dirname(out.ndjson));
  ensureDir(path.dirname(out.csv));
  ensureDir(out.rawDir);
  const csvNew = !fs.existsSync(out.csv) || fs.statSync(out.csv).size === 0;
  if (csvNew) fs.appendFileSync(out.csv, CSV_COLS.join(',') + '\n');
  return {
    write(rec) {
      fs.appendFileSync(out.ndjson, JSON.stringify(rec) + '\n');
      fs.appendFileSync(out.csv, CSV_COLS.map(c => csvCell(rec[c])).join(',') + '\n');
    },
  };
}

// ---- catalog grouping -------------------------------------------------------------------

// Group leaf indicators by their parent category path. Each group's leaves are siblings
// that can be selected + tabled together.
function buildGroups(catalog) {
  const leaves = catalog.items.filter(i => i.isLeaf && i.checkboxId);
  const map = new Map();
  for (const l of leaves) {
    const key = l.path.join(GKEY_SEP);
    if (!map.has(key)) map.set(key, { path: l.path, labels: [] });
    map.get(key).labels.push(l.label);
  }
  return [...map.values()];
}

function inScope(group, scope) {
  if (scope.categories && scope.categories.length && !scope.categories.includes(group.path[0])) return false;
  if (scope.includePaths && scope.includePaths.length) {
    const gk = group.path.join(GKEY_SEP);
    if (!scope.includePaths.some(p => gk.startsWith(p))) return false;
  }
  return true;
}

// Split a group's leaves into chunks of at most maxLeavesPerGroup.
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---- Table.aspx config reader -----------------------------------------------------------

// Read each selected item's label, itemId, VULNS instance id, and the concrete option
// values for Geography (reporting level), NORM (display), Years.
async function readConfig(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const items = [];
    for (const cb of document.querySelectorAll('input[name="VULNS"]')) {
      const label = clean((cb.parentElement || {}).textContent || '');
      const tr = cb.closest('tr');
      const sels = tr ? [...tr.querySelectorAll('select')] : [];
      const dims = {}; let itemId = null;
      for (const s of sels) {
        const m = s.name.match(/^(Geography|NORM|Years)___(\d+)_/);
        if (!m) continue;
        itemId = m[2];
        dims[m[1]] = [...s.options].map(o => ({ v: o.value, t: clean(o.textContent) }));
      }
      items.push({ vulns: cb.value, label, itemId, Geography: dims.Geography || [], NORM: dims.NORM || [], Years: dims.Years || [] });
    }
    return items;
  });
}

// Set one autopostback dropdown and wait for the resulting full-page postback to settle.
async function setSel(page, id, val, delayMs) {
  const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.selectOption('#' + id, val).catch(() => {});
  await navP;
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(delayMs);
}

// ---- dimension scope resolution ---------------------------------------------------------

const concreteVals = (opts, re) => opts.map(o => o.v).filter(v => v !== '*' && (!re || re.test(v)));

function resolveDisplays(items, scope) {
  if (Array.isArray(scope)) return scope;
  const set = new Set();
  for (const it of items) for (const v of concreteVals(it.NORM)) set.add(v);
  const displays = [...set];
  // {first:N} — take the first N discovered displays (broad shallow pass).
  if (scope && typeof scope === 'object' && scope.first) return displays.slice(0, scope.first);
  return displays;
}
function resolveYears(items, scope) {
  if (Array.isArray(scope)) return scope.map(String);
  const set = new Set();
  for (const it of items) for (const v of concreteVals(it.Years, /^\d{4}$/)) set.add(v);
  const years = [...set].sort((a, b) => Number(b) - Number(a));
  if (scope && typeof scope === 'object' && scope.latest) return years.slice(0, scope.latest);
  return years;
}

// ---- per-chunk harvest ------------------------------------------------------------------

// Run one chunk in a fresh, isolated browser context. Returns nothing; writes records and
// updates `state` as it goes (checkpointing after every cell).
async function harvestChunk(browser, target, group, chunkKey, labels, state, out, writers) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);

  // Capture every data-grid response the create-tables RadWindow fetches.
  const grids = [];
  ctx.on('response', async resp => {
    if (!/popups\/table\.aspx/i.test(resp.url())) return;
    try {
      const body = (await resp.body()).toString('utf8');
      grids.push({ url: resp.url(), status: resp.status(), body, ok: /rgMasterTable/i.test(body) });
    } catch { /* body unavailable */ }
  });

  try {
    // --- fresh project + selection for this chunk ---
    await page.goto(START, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_Dpl');
    await setGeographyType(page, target.geoTypeLabel);
    await selectAndCommitGeo(page, target.seedGeoId);
    const projectId = await gotoSelectData(page);
    await page.goto(`${BASE}/PopUps/SelectData.aspx?Originator=&ProjectID=${projectId || ''}`, { waitUntil: 'domcontentloaded' });
    await sleep(1200);

    const reached = await expandToPath(page, group.path, CONFIG.delayMs / 3 | 0);
    if (!reached) { log('  ! path unreachable, skipping chunk'); state.stats.errors++; return; }
    const ticked = await tickLeaves(page, group.path, labels);
    log(`  ticked ${ticked.length}/${labels.length} leaves`);
    if (!ticked.length) { log('  ! no leaves ticked, skipping chunk'); state.stats.errors++; return; }
    await commitSelection(page, CONFIG.delayMs);

    await page.goto(`${BASE}/Table.aspx`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(1000);
    const items = (await readConfig(page)).filter(it => it.itemId);
    if (!items.length) { log('  ! no configurable items on Table.aspx, skipping'); state.stats.errors++; return; }

    // Resolve the concrete reporting-level value. target.level may be an exact option
    // value ("Counties") or a distinctive substring ("ZIP" -> "ZIP Codes", "Census Tract"
    // -> "2010 Census Tracts") so we don't have to hardcode every site-specific label.
    const allLevelVals = [...new Set(items.flatMap(it => it.Geography.map(o => o.v)).filter(v => v && v !== '*'))];
    const wantLevel = String(target.level);
    const resolvedLevel = allLevelVals.find(v => v === wantLevel)
      || allLevelVals.find(v => v.toLowerCase().includes(wantLevel.toLowerCase()));
    if (!resolvedLevel) { log(`  (no reporting level matches "${wantLevel}"; available: ${allLevelVals.join(' | ') || 'none'}) marking chunk done`); state.chunkDone[chunkKey] = true; saveState(out.state, state); return; }
    let levelItems = items.filter(it => it.Geography.some(o => o.v === resolvedLevel));
    if (!levelItems.length) { log(`  (no items support level ${resolvedLevel}) marking chunk done`); state.chunkDone[chunkKey] = true; saveState(out.state, state); return; }

    // The reporting level controls which DISPLAYS and YEARS are actually available: finer
    // levels (tracts, blockgroups) publish fewer years than Counties. readConfig above was
    // taken at the page's default level, so PRIME the level once (set each item's Geography
    // -> its NORM/Years dropdowns repopulate via autopostback) then re-read to learn the
    // level-accurate options before resolving the display/year scope.
    for (const it of levelItems) await setSel(page, `Geography___${it.itemId}_1`, resolvedLevel, CONFIG.delayMs);
    const primed = (await readConfig(page)).filter(it => it.itemId);
    const primedById = new Map(primed.map(it => [it.itemId, it]));
    levelItems = levelItems.map(it => primedById.get(it.itemId) || it);

    const displays = resolveDisplays(levelItems, CONFIG.scope.displays);
    const years = resolveYears(levelItems, CONFIG.scope.years);
    // In 'refresh' mode, the newest N years are always re-fetched (revision window).
    const yearsDesc = [...years].sort((a, b) => Number(b) - Number(a));
    const refreshYears = SYNC.mode === 'refresh'
      ? new Set(yearsDesc.slice(0, SYNC.refreshLatestYears)) : new Set();
    log(`  displays=${displays.length} years=${years.length} -> up to ${displays.length * years.length} tables` +
        (refreshYears.size ? ` (refreshing years: ${[...refreshYears].join(', ')})` : ''));

    for (const display of displays) {
      for (const year of years) {
        const cellKey = `${chunkKey}|${display}|${year}`;
        if (state.done[cellKey] && !refreshYears.has(year)) continue;

        const active = levelItems.filter(it =>
          it.NORM.some(o => o.v === display) && it.Years.some(o => o.v === year));
        if (!active.length) { state.done[cellKey] = true; continue; }

        if (CONFIG.reloadBetweenCombos) {
          await page.goto(`${BASE}/Table.aspx`, { waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await sleep(500);
        }
        // configure each active item's three dropdowns (autopostback each)
        for (const it of active) {
          await setSel(page, `Geography___${it.itemId}_1`, resolvedLevel, CONFIG.delayMs);
          await setSel(page, `NORM___${it.itemId}_1`, display, CONFIG.delayMs);
          await setSel(page, `Years___${it.itemId}_1`, year, CONFIG.delayMs);
        }
        // tick only the active items' VULNS boxes (validation needs them checked)
        const wantVulns = active.map(a => a.vulns);
        await page.evaluate(vs => {
          for (const cb of document.querySelectorAll('input[name="VULNS"]')) {
            const should = vs.includes(cb.value);
            if (cb.checked !== should) cb.click();
          }
        }, wantVulns);

        // create tables -> capture the grid response. Finer levels (tracts, blockgroups)
        // return 1000+ rows and can take well over 30s to render, so make the wait
        // window configurable via CONFIG.gridWaitSec (default 30).
        const mark = grids.length;
        await page.click('#Tables').catch(() => {});
        let got = null;
        const gridWaitSec = CONFIG.gridWaitSec || 30;
        for (let t = 0; t < gridWaitSec && !got; t++) {
          await sleep(1000);
          for (let k = grids.length - 1; k >= mark; k--) { if (grids[k].ok) { got = grids[k]; break; } }
        }
        if (!got) { log(`  [${display} / ${year}] no grid captured`); state.stats.errors++; saveState(out.state, state); continue; }

        fs.writeFileSync(path.join(out.rawDir, `${cellKey.replace(/[^\w-]+/g, '_')}.html`), got.body);
        const grid = parseGrid(got.body);

        let n = 0;
        for (const it of active) {
          const col = findGridColumn(grid.columns, it.label);
          if (!col) continue;
          for (const row of grid.rows) {
            const value = row.values[col];
            if (value == null || value === '') continue;
            writers.write({
              category: group.path[0] || '',
              indicatorLabel: it.label,
              indicatorPath: group.path.join(' / '),
              geographyLevel: resolvedLevel,
              geoId: row.geoId,
              geoName: row.geoName,
              display, year, value,
              capturedAt: new Date().toISOString(),
            });
            n++;
          }
        }
        state.stats.records += n; state.stats.tables++;
        // A grid rendered but matched 0 columns for every active item = the colon-vs-dash
        // column-label mismatch that silently ticked cells done with no data. Emit a loud
        // WARNING and record the cell in state.suspect so verify/reset tooling can find it,
        // instead of marking it done invisibly.
        if (n === 0 && active.length && grid.rows.length) {
          log(`  [${display} / ${year}] WARNING grid captured (${grid.rows.length} rows, ${grid.columns.length} cols) but 0 records matched ${active.length} item(s) — possible column-label mismatch`);
          state.suspect = state.suspect || {};
          state.suspect[cellKey] = { rows: grid.rows.length, cols: grid.columns.length, items: active.length, labels: active.map(a => a.label), at: new Date().toISOString() };
        }
        state.done[cellKey] = true;
        saveState(out.state, state);
        log(`  [${display} / ${year}] ${grid.rows.length} geos x ${active.length} items -> ${n} records`);
        await sleep(CONFIG.delayMs);
      }
    }
    state.chunkDone[chunkKey] = true;
    saveState(out.state, state);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ---- main -------------------------------------------------------------------------------

(async () => {
  const out = CONFIG.output;
  const state = loadState(out.state);
  const writers = makeWriters(out);

  const allGroups = buildGroups(CATALOG);
  let groups = allGroups.filter(g => inScope(g, CONFIG.scope));
  if (CONFIG.scope.maxGroups) groups = groups.slice(0, CONFIG.scope.maxGroups);
  log(`Catalog groups in scope: ${groups.length} (of ${allGroups.length} total).`);
  log(`Sync mode: ${SYNC.mode}` + (SYNC.mode === 'refresh' ? ` (re-fetch latest ${SYNC.refreshLatestYears} years)` : ''));
  if (SHARD) log(`Shard: worker ${SHARD.index + 1}/${SHARD.total} (processes chunks where hash(chunkKey) % ${SHARD.total} == ${SHARD.index}).`);

  // One browser; each chunk gets its own fresh context (isolated session => empty project).
  const { browser, ctx: ctx0 } = await launch(!!CONFIG.headless);
  await ctx0.close().catch(() => {});

  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; log('SIGINT — will stop after the current chunk (state is checkpointed).'); });

  try {
    for (const target of CONFIG.reportingTargets) {
      for (const group of groups) {
        if (interrupted) break;
        const groupKey = group.path.join(GKEY_SEP);
        const chunks = chunk(group.labels, CONFIG.maxLeavesPerGroup || 8);
        for (let ci = 0; ci < chunks.length; ci++) {
          if (interrupted) break;
          const chunkKey = `${groupKey}|c${ci}|${target.level}`;
          if (SHARD && hashStr(chunkKey) % SHARD.total !== SHARD.index) continue;
          if (SYNC.mode !== 'refresh' && state.chunkDone[chunkKey]) continue;
          log(`\n=== ${groupKey}  [chunk ${ci + 1}/${chunks.length}, ${chunks[ci].length} items]  level=${target.level} ===`);
          try {
            await harvestChunk(browser, target, group, chunkKey, chunks[ci], state, out, writers);
          } catch (err) {
            log(`  ! chunk error: ${err.message}`); state.stats.errors++; saveState(out.state, state);
          }
        }
      }
    }
    log(`DONE. records=${state.stats.records} tables=${state.stats.tables} errors=${state.stats.errors}`);
    log(`Output: ${out.ndjson} , ${out.csv}`);
  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exitCode = 1;
  } finally {
    saveState(out.state, state);
    await browser.close();
  }
})();
