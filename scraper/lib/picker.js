// Reusable helpers to drive the SelectData.aspx picker (ASP.NET TreeView, populate-on-
// demand). Lets the harvester reach a specific category PATH and tick specific indicator
// leaves. Node ids (t0,t1..) renumber after every postback, so we always re-read the live
// tree and key on the DOM-derived category PATH + label, never on ids.
const { sleep } = require('./flow');

// Read every visible tree node with: label, category path (from DOM nesting), whether it
// is a leaf, whether it is expandable (an un-expanded toggle), and — for populate-on-demand
// nodes — the stable postback arg used to load its children.
async function readTree(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const labelOfContainer = div => {
      const m = div.id.match(/TVMenuSelectn(\d+)Nodes$/);
      if (!m) return null;
      const sp = document.getElementById(div.id.replace(/n(\d+)Nodes$/, 't$1'));
      return sp ? clean(sp.getAttribute('title') || sp.textContent) : null;
    };
    const out = [];
    for (const sp of document.querySelectorAll('span[id*="TVMenuSelectt"]')) {
      const label = clean(sp.getAttribute('title') || sp.textContent);
      if (!label) continue;
      const row = sp.closest('tr');
      const cb = row ? row.querySelector('input[type=checkbox][id*="CheckBox"]') : null;
      const anchor = row ? [...row.querySelectorAll('a')].find(a => a.querySelector('img[alt^="Expand"], img[alt^="Collapse"]')) : null;
      const img = anchor ? anchor.querySelector('img') : null;
      const expandable = img ? /^Expand/i.test(img.getAttribute('alt') || '') : false;
      const href = anchor ? (anchor.getAttribute('href') || '') : '';
      const isPostback = /__doPostBack/.test(href);
      let pbArg = null;
      if (isPostback) {
        const m = href.match(/__doPostBack\('[^']*',\s*'([\s\S]*)'\)/);
        pbArg = m ? m[1] : null;
      }
      // Category path from ancestor child-container divs.
      const path = [];
      let cur = sp.closest('div[id*="Nodes"]');
      while (cur) {
        const l = labelOfContainer(cur);
        if (l) path.unshift(l);
        cur = cur.parentElement ? cur.parentElement.closest('div[id*="Nodes"]') : null;
      }
      out.push({
        label, path,
        checkboxId: cb ? cb.id : null,
        isLeaf: !anchor,
        expandable, isPostback, pbArg,
      });
    }
    return out;
  });
}

const arrEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Fire a populate-on-demand postback for the node whose stable pbArg matches, then wait for
// the page to settle. Returns true if fired. (Native anchor.click() runs the href JS and
// works on hidden/deep anchors, which Playwright's visibility-gated click would refuse.)
async function firePostback(page, pbArg, delayMs) {
  const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const fired = await page.evaluate(want => {
    for (const a of document.querySelectorAll('a[href*="__doPostBack"]')) {
      const h = a.getAttribute('href') || '';
      const m = h.match(/__doPostBack\('[^']*',\s*'([\s\S]*)'\)/);
      if (m && m[1] === want) { a.click(); return true; }
    }
    return false;
  }, pbArg).catch(() => true); // context destroyed by navigation == it fired
  await navP;
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await sleep(delayMs);
  return fired;
}

// Expand the tree along `targetPath` (array of category labels) so the leaves directly
// under it become present in the DOM. Only populate-on-demand (postback) ancestors need a
// click; client-side toggle nodes already have their children in the DOM (just hidden).
// Returns true if the full path was reached.
async function expandToPath(page, targetPath, delayMs = 400) {
  for (let d = 0; d < targetPath.length; d++) {
    const wantParent = targetPath.slice(0, d);
    const wantLabel = targetPath[d];
    let tree = await readTree(page);
    let node = tree.find(n => n.label === wantLabel && arrEq(n.path, wantParent));
    if (!node) return false; // segment not visible — path unreachable
    if (node.expandable && node.isPostback && node.pbArg) {
      await firePostback(page, node.pbArg, delayMs);
    }
    // If expandable but client-side, or already expanded, children are already in the DOM.
  }
  return true;
}

// Tick the checkboxes for the given leaf labels directly under `parentPath`. Returns the
// labels actually ticked. Uses native click inside the page (deep rows may be hidden).
async function tickLeaves(page, parentPath, labels) {
  return page.evaluate(({ parentPath, labels }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const labelOfContainer = div => {
      const m = div.id.match(/TVMenuSelectn(\d+)Nodes$/);
      if (!m) return null;
      const sp = document.getElementById(div.id.replace(/n(\d+)Nodes$/, 't$1'));
      return sp ? clean(sp.getAttribute('title') || sp.textContent) : null;
    };
    const want = new Set(labels);
    const ticked = [];
    for (const sp of document.querySelectorAll('span[id*="TVMenuSelectt"]')) {
      const label = clean(sp.getAttribute('title') || sp.textContent);
      if (!want.has(label)) continue;
      const path = [];
      let cur = sp.closest('div[id*="Nodes"]');
      while (cur) {
        const l = labelOfContainer(cur);
        if (l) path.unshift(l);
        cur = cur.parentElement ? cur.parentElement.closest('div[id*="Nodes"]') : null;
      }
      if (path.length !== parentPath.length || !path.every((x, i) => x === parentPath[i])) continue;
      const row = sp.closest('tr');
      const cb = row ? row.querySelector('input[type=checkbox][id*="CheckBox"]') : null;
      if (cb && !cb.checked) { cb.click(); ticked.push(label); }
      else if (cb) { ticked.push(label); }
    }
    return ticked;
  }, { parentPath, labels });
}

// Commit the ticked selection to the project ("update selected items" button).
async function commitSelection(page, delayMs = 800) {
  const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.click('#ctl00_ContentPlaceHolder1_Select').catch(() => {});
  await navP;
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await sleep(delayMs);
}

module.exports = { readTree, expandToPath, tickLeaves, commitSelection, firePostback, arrEq };
