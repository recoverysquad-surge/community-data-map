// Definitive probe: reach the ACTUAL data output popup and dump values + format.
// Flow -> pick seed tract -> Select Data -> picker: tick 2 true-leaf items -> commit ->
// Table.aspx (config grid) -> read VULNS instance ids + item ids -> open
// /savi/popups/table.aspx?vulns=..&others= (the real data grid) -> dump.
const fs = require('fs');
const { START, launch, sleep, setGeographyType, selectAndCommitGeo, gotoSelectData, BASE } = require('./lib/flow');

const SEED_GEOID = '18097391000';
const WANT_LEAVES = 2;
const MAX_EXPAND = 10;
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
      const m = href.match(/__doPostBack\('[^']*',\s*'([\s\S]*)'\)/);
      out.push({ label, checkboxId: cb ? cb.id : null, expandable: !!anchor, isPostback: /__doPostBack/.test(href), pbArg: m ? m[1] : null });
    }
    return out;
  });
}

(async () => {
  const { browser, page } = await launch(true);
  try {
    await page.goto(START, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_Dpl');
    await setGeographyType(page, 'Census Tract');
    await selectAndCommitGeo(page, SEED_GEOID);
    const projectId = await gotoSelectData(page);
    log(`ProjectID = ${projectId}`);

    await page.goto(`${BASE}/PopUps/SelectData.aspx?Originator=&ProjectID=${projectId || ''}`, { waitUntil: 'domcontentloaded' });
    await sleep(1200);

    let expanded = 0; const done = new Set();
    while (expanded < MAX_EXPAND) {
      const nodes = await readNodes(page);
      if (nodes.filter(n => n.checkboxId && !n.expandable).length >= WANT_LEAVES) break;
      const t = nodes.find(n => n.expandable && n.isPostback && n.pbArg && !done.has(n.pbArg));
      if (!t) break; done.add(t.pbArg);
      const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.evaluate(want => { for (const a of document.querySelectorAll('a[href*="__doPostBack"]')) { const m = (a.getAttribute('href') || '').match(/__doPostBack\('[^']*',\s*'([\s\S]*)'\)/); if (m && m[1] === want) { a.click(); return; } } }, t.pbArg).catch(() => {});
      await navP; await sleep(250); expanded++;
    }

    const leaves = (await readNodes(page)).filter(n => n.checkboxId && !n.expandable).slice(0, WANT_LEAVES);
    log(`Ticking: ${leaves.map(l => l.label).join(' | ')}`);
    for (const l of leaves) await page.evaluate(id => { const c = document.getElementById(id); if (c && !c.checked) c.click(); }, l.checkboxId);
    await sleep(500);

    const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.click('#ctl00_ContentPlaceHolder1_Select').catch(() => {});
    await navP; await sleep(1500);
    log('Committed. Opening Table.aspx config grid...');

    await page.goto(`${BASE}/Table.aspx`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(1500);

    // Read the VULNS instance ids + the per-item config (item id, available years/levels).
    const cfg = await page.evaluate(() => {
      const vulns = Array.from(document.querySelectorAll('input[name="VULNS"]')).map(i => i.value);
      const items = {};
      for (const sel of document.querySelectorAll('select[id^="Years___"],select[id^="Geography___"],select[id^="NORM___"]')) {
        const m = sel.id.match(/^(Years|Geography|NORM)___(\d+)_/);
        if (!m) continue;
        const id = m[2]; items[id] = items[id] || { itemId: id };
        items[id][m[1]] = Array.from(sel.options).map(o => ({ v: o.value, t: (o.textContent || '').trim() }));
      }
      return { vulns, items: Object.values(items) };
    });
    log(`VULNS instance ids: ${cfg.vulns.join('|')}`);
    log(`Item ids: ${cfg.items.map(i => i.itemId).join(', ')}`);
    fs.writeFileSync('artifacts/probe_data_config.json', JSON.stringify(cfg, null, 2));

    // Open the ACTUAL data popup.
    const dataUrl = `${BASE}/popups/table.aspx?vulns=${cfg.vulns.join('|')}${cfg.vulns.length ? '|' : ''}&others=`;
    log(`Opening data popup: ${dataUrl}`);
    await page.goto(dataUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await sleep(2000);

    fs.writeFileSync('artifacts/probe_data.html', await page.content());
    await page.screenshot({ path: 'artifacts/probe_data.png', fullPage: true }).catch(() => {});

    const tables = await page.evaluate(() => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('table')).map(t => {
        const rows = Array.from(t.querySelectorAll('tr')).map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => clean(td.innerText)));
        return { id: t.id || null, nrows: rows.length, ncols: rows[0] ? rows[0].length : 0, preview: rows.slice(0, 12) };
      }).filter(t => t.nrows > 1 && t.ncols > 1);
    });
    fs.writeFileSync('artifacts/probe_data_parsed.json', JSON.stringify(tables, null, 2));
    log(`Data tables: ${tables.length}`);
    const big = tables.sort((a, b) => b.nrows * b.ncols - a.nrows * a.ncols)[0];
    if (big) { log(`Biggest ${big.nrows}x${big.ncols} #${big.id}:`); console.log(JSON.stringify(big.preview, null, 2)); }
    else log('No data grid found — dumping body text head:'), console.log((await page.evaluate(() => document.body.innerText)).slice(0, 800));
  } catch (err) {
    log(`ERROR: ${err.message}`);
    await page.screenshot({ path: 'artifacts/probe_data_error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
