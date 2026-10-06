// Step 2 of the Sites probe: actually ADD one asset type to the map and capture the
// server-injected LoadAssetLayers(AppID, KMLurl, NumberOfPoints, cat1~cat4, ...) call +
// any KML/asset network request. That KMLurl is the asset-point data endpoint we need.
//
// Target asset: Sites, Programs, & Agencies > Arts, Culture and Recreation > Facilities > Museums
//
// Run:
//   LD_LIBRARY_PATH=/mnt/c/temp/SAVI/scraper/.native/root/usr/lib/x86_64-linux-gnu \
//     node probe_sites_add.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { sleep } = require('./lib/flow');
const { expandToPath, tickLeaves, commitSelection, readTree } = require('./lib/picker');

const ART = path.join(__dirname, 'artifacts');
fs.mkdirSync(ART, { recursive: true });

const MAP_URL = 'https://classic.savi.org/savi/Map.aspx?ObjectID=0';
const SELECT_URL = 'https://classic.savi.org/savi/PopUps/SelectData.aspx?WizardMode=true&Originator='
  + encodeURIComponent(MAP_URL);

const TARGET_PARENT = ['Sites, Programs, & Agencies', 'Arts, Culture and Recreation', 'Facilities'];
const TARGET_LEAF = 'Museums';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);

  // Capture every asset/KML-ish request + response bodies that look like KML.
  const hits = [];
  page.on('request', r => {
    const u = r.url();
    if (/kml|overlay|asset|GetMapItems|GetPoints|\.ashx|savi_services|AssetMoreInfo|IDentify/i.test(u))
      hits.push(`${r.method()} ${u}`);
  });
  const kmlBodies = [];
  ctx.on('response', async resp => {
    const u = resp.url();
    if (/\.kml|GetOverlays|kml\?|asset/i.test(u)) {
      try {
        const ct = (resp.headers()['content-type'] || '');
        const body = await resp.text();
        if (/kml|<Placemark|<coordinates|<Point/i.test(body) || /kml/i.test(ct))
          kmlBodies.push({ url: u, ct, bytes: body.length, sample: body.slice(0, 2000) });
      } catch {}
    }
  });

  console.log('Opening SelectData (WizardMode, Originator=Map.aspx)...');
  await page.goto(SELECT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(1500);

  console.log('Expanding tree to:', TARGET_PARENT.join(' > '));
  const ok = await expandToPath(page, TARGET_PARENT, 600);
  console.log('  expandToPath ->', ok);

  const ticked = await tickLeaves(page, TARGET_PARENT, [TARGET_LEAF]);
  console.log('  ticked:', ticked);
  if (!ticked.length) {
    // Dump what leaves ARE visible under the parent, to adjust the target.
    const tree = await readTree(page);
    const near = tree.filter(n => n.path.join('>').startsWith('Sites')).slice(0, 40)
      .map(n => `${n.isLeaf ? 'LEAF' : 'node'} ${n.path.join(' > ')} :: ${n.label}`);
    fs.writeFileSync(path.join(ART, 'sites_add_tree.txt'), near.join('\n'));
    console.log('  (no leaf ticked; wrote visible Sites nodes to artifacts/sites_add_tree.txt)');
  }

  console.log('Committing selection (update selected items)...');
  await commitSelection(page, 1500);
  await sleep(2500);
  console.log('  landed on:', page.url());

  // Always navigate to Map.aspx now: the selected asset is held in the session project,
  // and Map.aspx injects the LoadAssetLayers(...) call + loads the KML. (The commit lands
  // back on SelectData; the Originator param merely NAMES Map.aspx.)
  console.log('Navigating to Map.aspx to read injected asset-load call...');
  await page.goto(MAP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await sleep(4000);

  const html = await page.content();
  fs.writeFileSync(path.join(ART, 'sites_add_map.html'), html);

  // Extract LoadAssetLayers(...) / LoadNumberedLayers(...) calls + any KMLurl literal.
  const calls = [...html.matchAll(/Load(?:Asset|Numbered)Layers\([^;]*\)/g)].map(m => m[0].slice(0, 400));
  const kmlLiterals = [...html.matchAll(/https?:\/\/[^"'()\s]*(?:kml|asset|GetMapItems|savi_services)[^"'()\s]*/gi)]
    .map(m => m[0]).slice(0, 30);
  const assetCbs = [...html.matchAll(/name="(Assets_[^"]+)"/g)].map(m => m[1]).slice(0, 30);

  const out = { landedUrl: page.url(), ticked, loadCalls: calls, kmlLiterals, assetCheckboxes: assetCbs, netHits: [...new Set(hits)], kmlBodies };
  fs.writeFileSync(path.join(ART, 'sites_add.json'), JSON.stringify(out, null, 2));

  console.log('\n=== LoadAssetLayers / LoadNumberedLayers calls ===');
  calls.forEach(c => console.log(c));
  console.log('\n=== KML/asset URL literals in page ===');
  kmlLiterals.forEach(u => console.log(u));
  console.log('\n=== Asset checkboxes present ===');
  assetCbs.forEach(c => console.log(c));
  console.log('\n=== Network hits (asset/kml) ===');
  console.log([...new Set(hits)].join('\n') || '(none)');
  console.log('\n=== KML response bodies captured ===');
  kmlBodies.forEach(b => console.log(`${b.url}  (${b.bytes}B, ${b.ct})`));
  console.log('\nFull dump -> artifacts/sites_add.json , page -> artifacts/sites_add_map.html');

  await browser.close();
})();
