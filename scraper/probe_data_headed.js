// HEADED probe to unblock value extraction. Same flow as probe_data_county.js but:
//  - launches a visible browser (WSLg DISPLAY=:0) so Telerik RadWindow behaves as in-app;
//  - records EVERY network request/response touching popups/table.aspx (method, url, status,
//    and the response body) so we can see exactly what "create tables" fetches + returns;
//  - inspects the DOM for RadWindow iframes and dumps their src.
const fs = require('fs');
const { START, launch, sleep, setGeographyType, selectAndCommitGeo, gotoSelectData, BASE } = require('./lib/flow');

const SEED_GEOID = '18097'; // Marion County
const WANT_LEAVES = 2;
const MAX_EXPAND = 10;
const HOLD_OPEN_MS = 20000; // keep the visible window up for observation
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
  const { browser, ctx, page } = await launch(false); // HEADED
  const netlog = [];
  ctx.on('response', async resp => {
    const url = resp.url();
    if (/popups\/table\.aspx/i.test(url)) {
      let bodyLen = -1, saved = null;
      try {
        const buf = await resp.body();
        bodyLen = buf.length;
        saved = `artifacts/net_table_${netlog.length}.html`;
        fs.writeFileSync(saved, buf);
      } catch {}
      const rec = { method: resp.request().method(), status: resp.status(), url, bodyLen, saved };
      netlog.push(rec);
      log(`  NET ${rec.method} ${rec.status} len=${bodyLen} -> ${saved || '(no body)'}`);
    }
  });

  try {
    await page.goto(START, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_Dpl');
    await setGeographyType(page, 'Counties');
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
    log(`VULNS instance ids: ${cfg.vulns.join('|')} | item ids: ${cfg.items.map(i => i.itemId).join(', ')}`);
    fs.writeFileSync('artifacts/probe_data_config.json', JSON.stringify(cfg, null, 2));

    const setSel = async (id, val) => {
      const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.selectOption('#' + id, val).catch(() => {});
      await navP;
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await sleep(500);
    };
    for (const it of cfg.items) {
      const yr = (it.Years || []).find(o => /^\d{4}$/.test(o.v));
      const lvl = (it.Geography || []).find(o => o.v === 'Counties') || (it.Geography || []).find(o => o.v !== '*');
      const disp = (it.NORM || []).find(o => o.v !== '*');
      if (lvl) await setSel(`Geography___${it.itemId}_1`, lvl.v);
      if (disp) await setSel(`NORM___${it.itemId}_1`, disp.v);
      if (yr) await setSel(`Years___${it.itemId}_1`, yr.v);
      log(`  configured item ${it.itemId}: level=${lvl ? lvl.v : '?'} display=${disp ? disp.v : '?'} year=${yr ? yr.v : '?'}`);
    }
    const vulns2 = await page.evaluate(() => Array.from(document.querySelectorAll('input[name="VULNS"]')).map(i => i.value));
    if (vulns2.length) cfg.vulns = vulns2;

    // validateItemOptionsTable() requires the VULNS checkboxes to actually be CHECKED
    // (WasChecked==true) before "create tables" will openRadWindow. Dropdowns were set
    // above (server-persisted via autopostback); now tick the boxes client-side (no
    // postback) so validation passes on click.
    const checkedCount = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('input[name="VULNS"]'));
      boxes.forEach(b => { if (!b.checked) b.click(); });
      return boxes.filter(b => b.checked).length;
    });
    log(`Checked ${checkedCount} VULNS checkboxes`);

    log('Clicking "create tables" (#Tables)...');
    let popupPage = null;
    ctx.on('page', p => { popupPage = p; log(`  NEW PAGE opened: ${p.url()}`); });
    await page.click('#Tables').catch(() => {});
    await sleep(6000);

    // Inspect DOM for any RadWindow iframe src.
    const iframeSrcs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).map(f => ({ id: f.id, name: f.name, src: f.src })).filter(f => f.src));
    fs.writeFileSync('artifacts/probe_headed_iframes.json', JSON.stringify(iframeSrcs, null, 2));
    log(`iframes on page: ${JSON.stringify(iframeSrcs)}`);

    // Try to locate the data frame (in-page iframe, or popup window).
    let dataFrame = null;
    for (let i = 0; i < 20 && !dataFrame; i++) {
      const allFrames = ctx.pages().flatMap(p => p.frames());
      dataFrame = allFrames.find(f => /popups\/table\.aspx/i.test(f.url()));
      if (!dataFrame && popupPage) dataFrame = popupPage.mainFrame();
      if (!dataFrame) await sleep(1000);
    }
    if (dataFrame) {
      log(`Data frame: ${dataFrame.url()}`);
      await dataFrame.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await sleep(2000);
      fs.writeFileSync('artifacts/probe_data.html', await dataFrame.content().catch(() => ''));
      const tables = await dataFrame.evaluate(() => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        return Array.from(document.querySelectorAll('table')).map(t => {
          const rows = Array.from(t.querySelectorAll('tr')).map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => clean(td.innerText)));
          return { id: t.id || null, nrows: rows.length, ncols: rows[0] ? rows[0].length : 0, preview: rows.slice(0, 15) };
        }).filter(t => t.nrows > 1 && t.ncols > 1);
      });
      fs.writeFileSync('artifacts/probe_data_parsed.json', JSON.stringify(tables, null, 2));
      const big = tables.sort((a, b) => b.nrows * b.ncols - a.nrows * a.ncols)[0];
      if (big) { log(`Biggest ${big.nrows}x${big.ncols} #${big.id}:`); console.log(JSON.stringify(big.preview, null, 2)); }
    } else {
      log('No data frame captured — relying on netlog captures above.');
    }

    await page.screenshot({ path: 'artifacts/probe_headed.png', fullPage: true }).catch(() => {});
    fs.writeFileSync('artifacts/probe_headed_netlog.json', JSON.stringify(netlog, null, 2));
    log(`Holding window open ${HOLD_OPEN_MS}ms for observation...`);
    await sleep(HOLD_OPEN_MS);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    await page.screenshot({ path: 'artifacts/probe_headed_error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
