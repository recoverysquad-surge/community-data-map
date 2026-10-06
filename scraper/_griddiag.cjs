// Diagnostic: replicate ONE breadth-pass chunk (Demographics Age Adults @ Blockgroup) and
// dump EVERY /popups/table.aspx response (status + has-grid flag + snippet) so we can see
// exactly why "no grid captured" happens for non-County levels.
const fs = require('fs');
const path = require('path');
const { START, BASE, launch, sleep, setGeographyType, selectAndCommitGeo, gotoSelectData } = require('./lib/flow');
const { expandToPath, tickLeaves, commitSelection } = require('./lib/picker');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const GKEY_SEP = ' \u203a ';

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
async function setSel(page, id, val) {
  const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.selectOption('#' + id, val).catch(() => {});
  await navP;
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(1200);
}

const TARGET = { level: '2010 Blockgroup', geoTypeLabel: '2010 Blockgroups', seedGeoId: '180973910003' };
const GROUP_PREFIX = 'Demographics \u203a Age \u203a Adults';

(async () => {
  const groups = buildGroups(CATALOG);
  const group = groups.find(g => g.path.join(GKEY_SEP).startsWith(GROUP_PREFIX));
  if (!group) { console.log('group not found'); return; }
  const labels = group.labels.slice(0, 8);
  console.log('group path:', group.path.join(' / '));
  console.log('labels:', labels.join(' | '));

  const { browser, ctx, page } = await launch(false);
  const resps = [];
  ctx.on('response', async resp => {
    if (!/popups\/table\.aspx/i.test(resp.url())) return;
    let body = '';
    try { body = (await resp.body()).toString('utf8'); } catch (e) { body = '<<body unavailable: ' + e.message + '>>'; }
    resps.push({ url: resp.url(), status: resp.status(), len: body.length, hasGrid: /rgMasterTable/i.test(body), body });
    console.log(`  [resp] status=${resp.status()} len=${body.length} hasGrid=${/rgMasterTable/i.test(body)} ${resp.url().slice(0,90)}`);
  });

  try {
    await page.goto(START, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_Dpl');
    const dpl = await setGeographyType(page, TARGET.geoTypeLabel);
    const cnt = await selectAndCommitGeo(page, TARGET.seedGeoId);
    console.log(`geoType dpl=${dpl} seed=${TARGET.seedGeoId} -> Search Results (${cnt})`);
    const projectId = await gotoSelectData(page);
    console.log('projectId:', projectId);
    await page.goto(`${BASE}/PopUps/SelectData.aspx?Originator=&ProjectID=${projectId || ''}`, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    const reached = await expandToPath(page, group.path, 400);
    console.log('reached path:', reached);
    const ticked = await tickLeaves(page, group.path, labels);
    console.log('ticked:', ticked.length);
    await commitSelection(page, 1200);

    await page.goto(`${BASE}/Table.aspx`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(1000);
    let items = (await readConfig(page)).filter(it => it.itemId);
    console.log('configurable items:', items.length);
    const allLevels = [...new Set(items.flatMap(it => it.Geography.map(o => o.v)).filter(v => v && v !== '*'))];
    console.log('levels available:', allLevels.join(' | '));
    const resolved = allLevels.find(v => v === TARGET.level) || allLevels.find(v => v.toLowerCase().includes(TARGET.level.toLowerCase()));
    console.log('resolved level:', resolved);
    if (!resolved) { console.log('LEVEL NOT AVAILABLE -> abort'); await browser.close(); return; }

    let levelItems = items.filter(it => it.Geography.some(o => o.v === resolved));
    for (const it of levelItems) await setSel(page, `Geography___${it.itemId}_1`, resolved);
    const primed = (await readConfig(page)).filter(it => it.itemId);
    const byId = new Map(primed.map(it => [it.itemId, it]));
    levelItems = levelItems.map(it => byId.get(it.itemId) || it);

    const first = levelItems[0];
    const display = (first.NORM.find(o => o.v !== '*') || {}).v;
    const year = (first.Years.map(o => o.v).filter(v => /^\d{4}$/.test(v)).sort().reverse()[0]);
    console.log(`using one combo: display=${display} year=${year} on ${levelItems.length} items`);

    await page.goto(`${BASE}/Table.aspx`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(500);
    for (const it of levelItems) {
      await setSel(page, `Geography___${it.itemId}_1`, resolved);
      await setSel(page, `NORM___${it.itemId}_1`, display);
      await setSel(page, `Years___${it.itemId}_1`, year);
    }
    const wantVulns = levelItems.map(a => a.vulns);
    await page.evaluate(vs => {
      for (const cb of document.querySelectorAll('input[name="VULNS"]')) {
        const should = vs.includes(cb.value);
        if (cb.checked !== should) cb.click();
      }
    }, wantVulns);
    console.log('clicking #Tables...');
    await page.click('#Tables').catch(e => console.log('click err', e.message));
    await sleep(45000); // long wait, capture whatever comes

    console.log('=== total table.aspx responses:', resps.length);
    resps.forEach((r, i) => fs.writeFileSync(`output/_griddiag_${i}.html`, r.body));
    // Also dump any validation alert text on the page
    const alertTxt = await page.evaluate(() => document.body.innerText.match(/same reporting level|must have|select at least|No data/gi) || []);
    console.log('page hints:', JSON.stringify(alertTxt));
  } catch (e) {
    console.log('ERROR', e.message, e.stack);
  } finally {
    await browser.close();
  }
})();
