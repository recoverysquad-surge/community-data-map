// One-shot probe: confirm the Table.aspx output shape so the harvester can be designed.
// Flow: pick seed tract -> commit -> Select Data (ProjectID) -> open picker popup ->
// expand a small branch, tick a few leaf data items, commit -> open Table.aspx -> dump.
const fs = require('fs');
const { START, launch, sleep, setGeographyType, selectAndCommitGeo, gotoSelectData, BASE } = require('./lib/flow');

const SEED_GEOID = '18097391000';
const WANT_LEAVES = 3;
const MAX_EXPAND = 8;

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

async function readNodes(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const sp of document.querySelectorAll('span[id*="TVMenuSelectt"]')) {
      const label = clean(sp.getAttribute('title') || sp.textContent);
      if (!label) continue;
      const row = sp.closest('tr');
      const cb = row ? row.querySelector('input[type=checkbox][id*="CheckBox"]') : null;
      const anchor = row ? [...row.querySelectorAll('a')].find(a => a.querySelector('img[alt^="Expand"]')) : null;
      const href = anchor ? (anchor.getAttribute('href') || '') : '';
      let pbArg = null;
      const m = href.match(/__doPostBack\('[^']*',\s*'([\s\S]*)'\)/);
      if (m) pbArg = m[1];
      out.push({ label, checkboxId: cb ? cb.id : null, expandable: !!anchor, isPostback: /__doPostBack/.test(href), pbArg });
    }
    return out;
  });
}

(async () => {
  const { browser, page } = await launch(true);
  try {
    log('Flow: select seed tract + commit...');
    await page.goto(START, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_Dpl');
    await setGeographyType(page, 'Census Tract');
    await selectAndCommitGeo(page, SEED_GEOID);
    const projectId = await gotoSelectData(page);
    log(`ProjectID = ${projectId}`);

    const popupUrl = `${BASE}/PopUps/SelectData.aspx?Originator=&ProjectID=${projectId || ''}`;
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    // Expand first postback node repeatedly until we have some leaf checkboxes.
    let expanded = 0;
    const done = new Set();
    while (expanded < MAX_EXPAND) {
      const nodes = await readNodes(page);
      // TRUE leaves = a checkbox with no expand toggle (real data items). Category nodes
      // also carry checkboxes (ticking one selects the whole subtree) — skip those here.
      const leaves = nodes.filter(n => n.checkboxId && !n.expandable);
      if (leaves.length >= WANT_LEAVES) break;
      // Expand down the FIRST branch: prefer the deepest available unexpanded postback node.
      const t = nodes.find(n => n.expandable && n.isPostback && n.pbArg && !done.has(n.pbArg));
      if (!t) break;
      done.add(t.pbArg);
      const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.evaluate(want => {
        for (const a of document.querySelectorAll('a[href*="__doPostBack"]')) {
          const m = (a.getAttribute('href') || '').match(/__doPostBack\('[^']*',\s*'([\s\S]*)'\)/);
          if (m && m[1] === want) { a.click(); return; }
        }
      }, t.pbArg).catch(() => {});
      await navP; await sleep(300); expanded++;
    }

    const nodes = await readNodes(page);
    const leaves = nodes.filter(n => n.checkboxId && !n.expandable).slice(0, WANT_LEAVES);
    log(`Ticking ${leaves.length} leaves: ${leaves.map(l => l.label).join(' | ')}`);
    for (const l of leaves) {
      await page.check('#' + l.checkboxId).catch(async () => {
        await page.evaluate(id => { const c = document.getElementById(id); if (c && !c.checked) c.click(); }, l.checkboxId);
      });
    }

    // Commit selection.
    const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.click('#ctl00_ContentPlaceHolder1_Select').catch(() => {});
    await navP; await sleep(1500);
    log('Committed items. Opening Table.aspx...');

    await page.goto(`${BASE}/Table.aspx`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(2000);

    fs.writeFileSync('artifacts/probe_table.html', await page.content());
    await page.screenshot({ path: 'artifacts/probe_table.png', fullPage: true }).catch(() => {});

    // Parse every table with >1 row, dump a preview.
    const tables = await page.evaluate(() => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('table')).map(t => {
        const rows = Array.from(t.querySelectorAll('tr')).map(tr =>
          Array.from(tr.querySelectorAll('th,td')).map(td => clean(td.innerText)));
        return { id: t.id || null, cls: t.className || null, nrows: rows.length,
          ncols: rows[0] ? rows[0].length : 0, preview: rows.slice(0, 6) };
      }).filter(t => t.nrows > 1);
    });
    fs.writeFileSync('artifacts/probe_table_parsed.json', JSON.stringify(tables, null, 2));
    log(`Tables with data: ${tables.length}`);
    for (const t of tables) log(`  table#${t.id || '(anon)'} ${t.nrows}x${t.ncols}`);
    const biggest = tables.sort((a, b) => b.nrows * b.ncols - a.nrows * a.ncols)[0];
    if (biggest) { log('Biggest table preview:'); console.log(JSON.stringify(biggest.preview, null, 2)); }
  } catch (err) {
    log(`ERROR: ${err.message}`);
    await page.screenshot({ path: 'artifacts/probe_error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
