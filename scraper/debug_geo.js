// Focused debug: why does a finer-level (Census Tract) table fail to capture?
// Drives the proven flow to Table.aspx at tract level for 2 demographics leaves,
// then instruments the create-tables step: validation result, VULNS checked count,
// popup/window events, and EVERY network response (url/status/rgMasterTable?).
//
// Run: LD_LIBRARY_PATH=.../x86_64-linux-gnu DISPLAY=:0 node debug_geo.js
//   or: ./run-harvest.sh is not used; use: DISPLAY=:0 node debug_geo.js  (set LD path)

const fs = require('fs');
const path = require('path');
const { START, BASE, launch, sleep, setGeographyType, selectAndCommitGeo, gotoSelectData } = require('./lib/flow');
const { expandToPath, tickLeaves, commitSelection } = require('./lib/picker');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const OUT = path.join(__dirname, 'artifacts');
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// --- reuse harvester's config reader + dropdown setter (copied minimal) ---
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
async function setSel(page, id, val, delayMs = 1200) {
  const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.selectOption('#' + id, val).catch(() => {});
  await navP;
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(delayMs);
}

// Pick the first demographics group with >=2 leaves.
function pickGroup() {
  const leaves = CATALOG.items.filter(i => i.isLeaf && i.checkboxId && i.path[0] === 'Demographics');
  const byPath = new Map();
  for (const l of leaves) { const k = l.path.join(' › '); if (!byPath.has(k)) byPath.set(k, { path: l.path, labels: [] }); byPath.get(k).labels.push(l.label); }
  for (const g of byPath.values()) if (g.labels.length >= 2) return { path: g.path, labels: g.labels.slice(0, 2) };
  const first = [...byPath.values()][0];
  return { path: first.path, labels: first.labels.slice(0, 2) };
}

(async () => {
  const { browser, ctx, page } = await launch(false);
  page.setDefaultTimeout(90000);

  // Log EVERY response so we see where the grid really comes from (or doesn't).
  const responses = [];
  ctx.on('response', async resp => {
    const url = resp.url();
    if (/\.(png|jpg|gif|css|woff2?|ico)(\?|$)/i.test(url)) return;
    let hasGrid = false, len = 0;
    try { const b = await resp.body(); len = b.length; hasGrid = /rgMasterTable/i.test(b.toString('utf8')); } catch {}
    responses.push({ url, status: resp.status(), len, hasGrid });
    if (/table\.aspx|table|grid|window/i.test(url)) log('  resp', resp.status(), hasGrid ? 'GRID' : '', len, url.slice(0, 120));
  });
  ctx.on('page', p => log('  >> NEW PAGE (popup):', p.url()));
  page.on('dialog', async d => { log('  >> DIALOG:', d.type(), d.message()); await d.accept().catch(() => {}); });

  const group = pickGroup();
  log('group:', group.path.join(' › '), '| leaves:', group.labels.join(', '));

  log('setGeographyType -> 2010 Census Tracts');
  await page.goto(START, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ctl00_ContentPlaceHolder1_Dpl');
  await setGeographyType(page, '2010 Census Tracts');
  const cnt = await selectAndCommitGeo(page, '18097391000');
  log('search results:', cnt);

  const projectId = await gotoSelectData(page);
  log('projectId:', projectId);
  await page.goto(`${BASE}/PopUps/SelectData.aspx?Originator=&ProjectID=${projectId || ''}`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const reached = await expandToPath(page, group.path, 400);
  log('expandToPath reached:', reached);
  const ticked = await tickLeaves(page, group.path, group.labels);
  log('ticked:', ticked.join(', '));
  await commitSelection(page, 1500);

  await page.goto(`${BASE}/Table.aspx`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(1000);
  const items = (await readConfig(page)).filter(it => it.itemId);
  log('items on Table.aspx:', items.length);
  for (const it of items) {
    log('  item', it.itemId, '| levels:', it.Geography.map(o => o.v).join('|'),
        '| displays:', it.NORM.map(o => o.v).slice(0, 4).join('|'),
        '| years:', it.Years.map(o => o.v).filter(v => /^\d{4}$/.test(v)).join(','));
  }

  // choose 2010 tract level
  const levelVals = [...new Set(items.flatMap(it => it.Geography.map(o => o.v)).filter(v => v && v !== '*'))];
  const level = levelVals.find(v => /2010 census tract/i.test(v)) || levelVals.find(v => /census tract/i.test(v)) || levelVals[0];
  const levelItems0 = items.filter(it => it.Geography.some(o => o.v === level));
  log(`CHOSEN level="${level}" | items supporting it:`, levelItems0.length);

  // PRIME the level: set Geography on each item so NORM/Years repopulate to level-specific
  // options, then RE-READ to learn which displays/years actually exist at this level.
  for (const it of levelItems0) await setSel(page, `Geography___${it.itemId}_1`, level);
  const primed = (await readConfig(page)).filter(it => it.itemId);
  const byId = new Map(primed.map(it => [it.itemId, it]));
  const levelItems = levelItems0.map(it => byId.get(it.itemId) || it);
  for (const it of levelItems) {
    log(`  primed item ${it.itemId} | displays:`, it.NORM.map(o => o.v).filter(v => v !== '*').join('|'),
        '| years:', it.Years.map(o => o.v).filter(v => /^\d{4}$/.test(v)).join(','));
  }
  const shared = (dim) => {
    let inter = null;
    for (const it of levelItems) {
      const s = new Set(it[dim].map(o => o.v).filter(v => v && v !== '*'));
      inter = inter === null ? s : new Set([...inter].filter(v => s.has(v)));
    }
    return [...(inter || [])];
  };
  const display = shared('NORM')[0];
  const yearVals = shared('Years').filter(v => /^\d{4}$/.test(v)).sort((a, b) => b - a);
  const year = yearVals[0];
  log(`CHOSEN (level-specific) display="${display}" year="${year}"`);

  for (const it of levelItems) {
    await setSel(page, `NORM___${it.itemId}_1`, display);
    await setSel(page, `Years___${it.itemId}_1`, year);
  }
  const want = levelItems.map(a => a.vulns);
  const checked = await page.evaluate(vs => {
    let n = 0;
    for (const cb of document.querySelectorAll('input[name="VULNS"]')) {
      const should = vs.includes(cb.value);
      if (cb.checked !== should) cb.click();
      if (cb.checked) n++;
    }
    return n;
  }, want);
  log('VULNS checked:', checked, 'of wanted', want.length);

  // Inspect validation + what #Tables will do.
  const diag = await page.evaluate(() => {
    const r = {};
    try { r.validate = typeof validateItemOptionsTable === 'function' ? validateItemOptionsTable() : 'no fn'; }
    catch (e) { r.validate = 'threw: ' + e.message; }
    const btn = document.querySelector('#Tables');
    r.tablesBtn = btn ? (btn.getAttribute('onclick') || btn.outerHTML.slice(0, 200)) : 'no #Tables';
    r.showFn = typeof ShowTableDataWindow === 'function' ? 'present' : 'absent';
    return r;
  });
  log('DIAG validate():', diag.validate);
  log('DIAG #Tables:', diag.tablesBtn);
  log('DIAG ShowTableDataWindow:', diag.showFn);

  const mark = responses.length;
  log('clicking #Tables ...');
  await page.click('#Tables').catch(e => log('click err', e.message));

  // wait up to 150s, report when/if a grid appears
  let got = null;
  for (let t = 0; t < 150 && !got; t++) {
    await sleep(1000);
    for (let k = responses.length - 1; k >= mark; k--) if (responses[k].hasGrid) { got = responses[k]; break; }
    if (t === 30 || t === 60 || t === 120) log(`  ...${t}s, responses since click:`, responses.length - mark);
  }
  log('GRID captured?', got ? `YES ${got.url}` : 'NO');
  log('all responses since click:');
  for (let k = mark; k < responses.length; k++) log('   ', responses[k].status, responses[k].hasGrid ? 'GRID' : '    ', responses[k].len, responses[k].url.slice(0, 140));

  fs.writeFileSync(path.join(OUT, 'debug_geo_page.html'), await page.content());
  await page.screenshot({ path: path.join(OUT, 'debug_geo.png'), fullPage: false }).catch(() => {});
  log('saved artifacts/debug_geo_page.html + debug_geo.png');
  await sleep(2000);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
