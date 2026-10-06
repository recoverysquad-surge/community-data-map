// SAVI "Sites, Programs, & Agencies" POINT harvester.
//
// The tabular harvester (harvest.js) can't reach Sites because they aren't tabular
// indicators — they're POINT ASSETS (facility/program/agency locations) shown as markers on
// the classic map. This harvester pulls those points.
//
// How the classic site serves them (discovered via probe_sites_add.js):
//   When an asset leaf is added to the session project and Map.aspx is loaded, the server
//   INJECTS every point inline into the page as a LoadInitialAssets() function full of:
//     TurnOn_Asset_marker(lat, lon, 'NAME<br/>..AssetMoreInfo.aspx?AssetID=NNN..', group, icon)
//   and renders an asset checkbox panel row per group:
//     <input name="Assets_<c1>_<c2>_<c3>_<c4>_<DataYear>" onclick="ToggleAssetLayer(...)">
//     <td>"<DataYear> <leaf label>"</td>
//   The marker's `group` arg matches the panel checkbox name, so each point is attributed to
//   its leaf. No separate KML endpoint is needed.
//
// Unit of work = a GROUP: all sibling asset leaves under one category path, ticked together
// (one commit + one Map.aspx load => all their points), then attributed per group code.
// This is ~168 groups for Sites (vs 1055 leaves) — far more polite.
//
// Properties (mirrors harvest.js):
//   - config-driven  (harvest_sites.config.json)
//   - resumable      (state file records every completed group; re-runs skip them)
//   - polite         (delayMs between server interactions; fresh context per group)
//
// Run (needs a real display — WizardMode + Map.aspx render under WSLg):
//   LD_LIBRARY_PATH=/mnt/c/temp/SAVI/scraper/.native/root/usr/lib/x86_64-linux-gnu \
//     DISPLAY=:0 node harvest_sites.js [harvest_sites.config.json]

const fs = require('fs');
const path = require('path');
const { BASE, launch, sleep } = require('./lib/flow');
const { expandToPath, tickLeaves, commitSelection } = require('./lib/picker');

const CFG_PATH = process.argv[2] || path.join(__dirname, 'harvest_sites.config.json');
const CONFIG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));

const MAP_URL = `${BASE}/Map.aspx?ObjectID=0`;
const SELECT_URL = `${BASE}/PopUps/SelectData.aspx?WizardMode=true&Originator=` + encodeURIComponent(MAP_URL);

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }
const GKEY_SEP = ' \u203a '; // "›" — same readable group key separator harvest.js uses

// ---- output + state ---------------------------------------------------------------------

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { startedAt: new Date().toISOString(), groupDone: {}, stats: { points: 0, groups: 0, empty: 0, errors: 0 } }; }
}
function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const CSV_COLS = ['category', 'assetType', 'indicatorPath', 'assetId', 'name', 'lat', 'lng', 'dataYear', 'icon', 'capturedAt'];

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

// ---- catalog grouping (same convention as harvest.js) -----------------------------------

// Group true-leaf asset items by their parent category path. Each group's leaves are
// siblings selected together.
function buildGroups(catalog) {
  const leaves = catalog.items.filter(i => i.isLeaf && i.checkboxId && i.path[0] && /^Sites/.test(i.path[0]));
  const map = new Map();
  for (const l of leaves) {
    const key = l.path.join(GKEY_SEP);
    if (!map.has(key)) map.set(key, { path: l.path, labels: [] });
    map.get(key).labels.push(l.label);
  }
  return [...map.values()];
}

function inScope(group, scope) {
  if (!scope) return true;
  if (scope.includePaths && scope.includePaths.length) {
    const gk = group.path.join(GKEY_SEP);
    if (!scope.includePaths.some(p => gk.startsWith(p))) return false;
  }
  return true;
}

// ---- Map.aspx point extraction ----------------------------------------------------------

// Parse the injected TurnOn_Asset_marker(...) calls + the asset checkbox panel from the
// Map.aspx HTML. Returns { markers: [{lat,lng,name,assetId,group,icon}], panel: {group->{label,dataYear}} }.
function parseAssets(html) {
  // Panel: <input ... name="Assets_1_24_210__MOST_RECENT" ...></td> <td ...>2018 Museums</td>
  const panel = {};
  const panelRe = /name="(Assets_[^"]+)"[^>]*>\s*<\/td>\s*<td[^>]*>([^<]+)<\/td>/gi;
  for (const m of html.matchAll(panelRe)) {
    const group = m[1];
    const txt = m[2].replace(/\s+/g, ' ').trim();          // e.g. "2018 Museums"
    const ym = txt.match(/^(\d{4})\s+(.*)$/);              // split leading data year
    panel[group] = ym ? { dataYear: ym[1], label: ym[2] } : { dataYear: '', label: txt };
  }

  // Markers: TurnOn_Asset_marker('lat','lon', 'NAME<br/>..AssetID=NNN..', 'group', 'icon')
  const markers = [];
  const markRe = /TurnOn_Asset_marker\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([\s\S]*?)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
  for (const m of html.matchAll(markRe)) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const infoHtml = m[3];
    const group = m[4];
    const icon = m[5];
    const nameM = infoHtml.match(/^([\s\S]*?)<br/i);
    const name = (nameM ? nameM[1] : infoHtml).replace(/\s+/g, ' ').trim();
    const idM = infoHtml.match(/AssetID=(\d+)/i);
    const assetId = idM ? idM[1] : null;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      markers.push({ lat, lng, name, assetId, group, icon });
    }
  }
  return { markers, panel };
}

// ---- per-group harvest ------------------------------------------------------------------

async function harvestGroup(browser, group, state, out, writers) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(CONFIG.navTimeoutMs || 90000);
  const groupKey = group.path.join(GKEY_SEP);
  try {
    await page.goto(SELECT_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(CONFIG.delayMs || 1500);

    const ok = await expandToPath(page, group.path, CONFIG.delayMs || 600);
    if (!ok) { log(`  ! could not expand to path — skipping`); state.stats.errors++; return; }

    const ticked = await tickLeaves(page, group.path, group.labels);
    log(`  ticked ${ticked.length}/${group.labels.length} leaves`);
    if (!ticked.length) { log(`  ! no leaves ticked — skipping`); state.stats.errors++; return; }

    await commitSelection(page, CONFIG.delayMs || 1500);

    await page.goto(MAP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await sleep(CONFIG.delayMs || 3000);

    const html = await page.content();
    const slug = groupKey.replace(/[^\w]+/g, '_').slice(0, 80);
    fs.writeFileSync(path.join(out.rawDir, `${slug}.html`), html);

    const { markers, panel } = parseAssets(html);
    const capturedAt = new Date().toISOString();
    let n = 0;
    for (const mk of markers) {
      const info = panel[mk.group] || {};
      // Resolve the specific leaf label: prefer the panel label; fall back to any ticked
      // label that is a substring of it.
      let assetType = info.label || '';
      if (!assetType) assetType = ticked.find(l => (info.label || '').includes(l)) || '';
      writers.write({
        category: group.path[0],
        assetType: assetType || mk.group,
        indicatorPath: [...group.path, assetType].filter(Boolean).join(' / '),
        assetId: mk.assetId,
        name: mk.name,
        lat: mk.lat,
        lng: mk.lng,
        dataYear: info.dataYear || '',
        icon: mk.icon,
        capturedAt,
      });
      n++;
    }
    state.stats.points += n;
    state.stats.groups++;
    if (n === 0) { state.stats.empty++; log(`  (0 points — flagged empty; ticked=${ticked.length})`); }
    else log(`  captured ${n} points across ${Object.keys(panel).length} asset group(s)`);

    state.groupDone[groupKey] = { points: n, at: capturedAt };
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
  if (CONFIG.scope && CONFIG.scope.maxGroups) groups = groups.slice(0, CONFIG.scope.maxGroups);
  log(`Sites groups in scope: ${groups.length} (of ${allGroups.length} total).`);

  const { browser, ctx: ctx0 } = await launch(!!CONFIG.headless);
  await ctx0.close().catch(() => {});

  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; log('SIGINT — will stop after the current group (state is checkpointed).'); });

  try {
    for (const group of groups) {
      if (interrupted) break;
      const groupKey = group.path.join(GKEY_SEP);
      if (state.groupDone[groupKey]) continue;
      log(`\n=== ${groupKey}  [${group.labels.length} leaves] ===`);
      try {
        await harvestGroup(browser, group, state, out, writers);
      } catch (err) {
        log(`  ! group error: ${err.message}`); state.stats.errors++; saveState(out.state, state);
      }
    }
    log(`DONE. points=${state.stats.points} groups=${state.stats.groups} empty=${state.stats.empty} errors=${state.stats.errors}`);
    log(`Output: ${out.ndjson} , ${out.csv}`);
  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exitCode = 1;
  } finally {
    saveState(out.state, state);
    await browser.close();
  }
})();
