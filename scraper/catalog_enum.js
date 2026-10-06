// Enumerate the ENTIRE SAVI data-item catalog.
// The picker is an ASP.NET TreeView (TVMenuSelect) with populate-on-demand: every
// "Expand" toggle is a __doPostBack that loads that node's children. We expand every
// node (one postback at a time, since each reloads the page) until no "Expand" toggles
// remain, then record every node: label, full category path, and checkbox id (leaves).
// Checkpoints catalog.json continuously so an interruption keeps progress.
const fs = require('fs');
const { START, launch, sleep, setGeographyType, selectAndCommitGeo, gotoSelectData, BASE } = require('./lib/flow');

const OUT = 'catalog.json';
const SEED_GEOID = '18097391000';
const MAX_POSTBACKS = 6000; // safety cap

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

// Snapshot current tree nodes from the DOM.
async function readNodes(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    // Node label spans: id contains "TVMenuSelectt<n>" ; title = label.
    const spans = Array.from(document.querySelectorAll('span[id*="TVMenuSelectt"]'));
    for (const sp of spans) {
      const label = clean(sp.getAttribute('title') || sp.textContent);
      if (!label) continue;
      // The row's checkbox (if any) sits in the same node table row.
      const row = sp.closest('tr');
      const cb = row ? row.querySelector('input[type=checkbox][id*="CheckBox"]') : null;
      // Expand toggle anchor in this row (means it has children).
      const anchor = row ? [...row.querySelectorAll('a')].find(a => a.querySelector('img[alt^="Expand"], img[alt^="Collapse"]')) : null;
      const img = anchor ? anchor.querySelector('img') : null;
      const expandable = img ? /^Expand/i.test(img.getAttribute('alt') || '') : false;
      const href = anchor ? (anchor.getAttribute('href') || '') : '';
      const isPostback = /__doPostBack/.test(href);
      // Populate-on-demand nodes carry a stable data path as the 2nd __doPostBack arg,
      // e.g. __doPostBack('...$TVMenuSelect','t<b>Health</b>\\VULNERABILITY||...').
      // Node ids (t0,t1..) renumber after every postback, so key expansion by this path.
      let pbArg = null;
      if (isPostback) {
        const m = href.match(/__doPostBack\('[^']*',\s*'([\s\S]*)'\)/);
        pbArg = m ? m[1] : null;
      }
      out.push({
        id: sp.id,
        label,
        checkboxId: cb ? cb.id : null,
        anchorId: anchor ? anchor.id : null,
        isPostback,
        pbArg,        // stable key for populate-on-demand expansion
        expandable,   // has children NOT yet expanded
      });
    }
    return out;
  });
}

// Compute a category path for each node by DOM nesting of the "...nNNNodes" child divs.
async function readNodesWithPaths(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const labelOfContainer = div => {
      // The child-container div id is "...TVMenuSelectn<K>Nodes"; its owning node
      // label span is "...TVMenuSelectt<K>". Map n<K> -> t<K>.
      const m = div.id.match(/TVMenuSelectn(\d+)Nodes$/);
      if (!m) return null;
      const sp = document.getElementById(div.id.replace(/n(\d+)Nodes$/, 't$1'));
      return sp ? clean(sp.getAttribute('title') || sp.textContent) : null;
    };
    const out = [];
    const spans = Array.from(document.querySelectorAll('span[id*="TVMenuSelectt"]'));
    for (const sp of spans) {
      const label = clean(sp.getAttribute('title') || sp.textContent);
      if (!label) continue;
      const row = sp.closest('tr');
      const cb = row ? row.querySelector('input[type=checkbox][id*="CheckBox"]') : null;
      const toggleImg = row ? row.querySelector('a img[alt^="Expand"], a img[alt^="Collapse"]') : null;
      // Walk up ancestor child-container divs to build the path.
      const path = [];
      let cur = sp.closest('div[id*="Nodes"]');
      while (cur) {
        const l = labelOfContainer(cur);
        if (l) path.unshift(l);
        cur = cur.parentElement ? cur.parentElement.closest('div[id*="Nodes"]') : null;
      }
      out.push({
        id: sp.id,
        label,
        path,
        checkboxId: cb ? cb.id : null,
        checkboxName: cb ? cb.name : null,
        isLeaf: !toggleImg,
      });
    }
    return out;
  });
}

(async () => {
  const { browser, page } = await launch(true);
  try {
    log('Opening flow to obtain a project/session...');
    await page.goto(START, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_Dpl');
    await setGeographyType(page, 'Census Tract');
    await selectAndCommitGeo(page, SEED_GEOID);
    const projectId = await gotoSelectData(page);
    log(`ProjectID = ${projectId}`);

    const popupUrl = `${BASE}/PopUps/SelectData.aspx?Originator=&ProjectID=${projectId || ''}`;
    log(`Opening picker: ${popupUrl}`);
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Expand every populate-on-demand node, one postback at a time. Node ids renumber
    // after each postback, so we key expansion by the stable data path (pbArg) and, for
    // safety, re-locate the live anchor by that path right before clicking.
    let postbacks = 0;
    const expandedPaths = new Set();
    while (postbacks < MAX_POSTBACKS) {
      const nodes = await readNodes(page);
      // Only __doPostBack toggles need a click to load children; TreeView_ToggleNode
      // nodes already have their children in the DOM (just hidden) so they enumerate fine.
      const target = nodes.find(n => n.expandable && n.isPostback && n.pbArg && !expandedPaths.has(n.pbArg));
      if (!target) { log(`No more populate-on-demand nodes. Total postbacks: ${postbacks}.`); break; }
      expandedPaths.add(target.pbArg);

      // Fire the populate-on-demand postback by locating the anchor whose href arg matches
      // this path and calling its native .click(). element.click() runs the href JS with
      // correct string-escape evaluation AND works on hidden elements (deep anchors can sit
      // under a collapsed ancestor, which would defeat Playwright's visibility-gated click).
      // Register the navigation wait BEFORE clicking to avoid a race.
      const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const fired = await page.evaluate(want => {
        const anchors = Array.from(document.querySelectorAll('a[href*="__doPostBack"]'));
        for (const a of anchors) {
          const h = a.getAttribute('href') || '';
          const m = h.match(/__doPostBack\('[^']*',\s*'([\s\S]*)'\)/);
          if (m && m[1] === want) { a.click(); return true; }
        }
        return false;
      }, target.pbArg).catch(() => true); // context destroyed by navigation == it fired
      if (!fired) { log(`  (skip) anchor for "${target.label}" not found`); continue; }
      await navP;
      postbacks++;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await sleep(400); // polite delay — avoid hammering the server

      if (postbacks % 20 === 0) {
        const snap = await readNodesWithPaths(page);
        const leaves = snap.filter(n => n.checkboxId);
        fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), partial: true, postbacks, totalNodes: snap.length, totalDataItems: leaves.length, items: snap }, null, 2));
        log(`  progress: ${postbacks} postbacks, ${snap.length} nodes, ${leaves.length} data items so far`);
      }
    }

    // Final extraction.
    const snap = await readNodesWithPaths(page);
    const leaves = snap.filter(n => n.checkboxId);
    const categories = [...new Set(snap.filter(n => n.path.length === 0).map(n => n.label))];
    fs.writeFileSync(OUT, JSON.stringify({
      capturedAt: new Date().toISOString(), partial: false, postbacks,
      totalNodes: snap.length, totalDataItems: leaves.length, categories, items: snap,
    }, null, 2));
    await page.screenshot({ path: 'artifacts/catalog_final.png', fullPage: true }).catch(() => {});
    log(`DONE. ${snap.length} nodes, ${leaves.length} data items, ${categories.length} top categories.`);
    log(`Categories: ${categories.join(' | ')}`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    await page.screenshot({ path: 'artifacts/catalog_error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
