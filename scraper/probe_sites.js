// One-off discovery probe: find how classic SAVI serves "Sites, Programs, & Agencies"
// ASSET POINT data (facility locations), which the tabular harvester can't reach.
//
// Strategy: load the classic SAVI map/home, capture EVERY network request (to spot the
// asset/points endpoint), and dump any UI controls that mention asset/site/layer/category
// so we can see how assets are toggled. Writes findings to artifacts/sites_probe_*.
//
// Run (headless ok for network capture):
//   LD_LIBRARY_PATH=/mnt/c/temp/SAVI/scraper/.native/root/usr/lib/x86_64-linux-gnu \
//     node probe_sites.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ART = path.join(__dirname, 'artifacts');
fs.mkdirSync(ART, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Candidate entry points for the classic map / asset browser.
const URLS = [
  'https://classic.savi.org/savi/',
  'https://classic.savi.org/savi/Default.aspx',
  'https://classic.savi.org/savi/Map.aspx',
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  const reqs = [];
  page.on('request', r => reqs.push(`${r.method()} ${r.url()}`));
  const interesting = new Set();
  page.on('request', r => {
    const u = r.url();
    if (/asset|site|program|agenc|facilit|point|marker|kml|layer|GetData|\.ashx|\.asmx|LocalServices|json/i.test(u))
      interesting.add(`${r.method()} ${u}`);
  });

  const results = {};
  for (const url of URLS) {
    const before = reqs.length;
    let status = 'ok';
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      status = resp ? resp.status() : 'no-response';
    } catch (e) { status = 'ERR: ' + e.message; }
    await sleep(2500);

    // Look for asset/layer UI controls on this page.
    const controls = await page.$$eval('a, button, input, select, [onclick]', els =>
      els.map(e => ({
        tag: e.tagName,
        id: e.id || '',
        text: (e.value || e.textContent || '').trim().slice(0, 50),
        href: (e.getAttribute && (e.getAttribute('href') || '')).slice(0, 90),
        onclick: (e.getAttribute && (e.getAttribute('onclick') || '')).slice(0, 90),
      }))
      .filter(c => /asset|site|program|agenc|facilit|map|layer|categor/i.test(
        c.text + ' ' + c.id + ' ' + c.href + ' ' + c.onclick))
      .slice(0, 40)
    ).catch(() => []);

    const title = await page.title().catch(() => '');
    results[url] = { status, title, newRequests: reqs.length - before, controls };
    const slug = url.replace(/[^\w]+/g, '_').slice(-40);
    fs.writeFileSync(path.join(ART, `sites_probe${slug}.html`), await page.content().catch(() => ''));
  }

  const out = {
    pages: results,
    interestingRequests: [...interesting],
    allRequestsSample: reqs.slice(0, 200),
    totalRequests: reqs.length,
  };
  fs.writeFileSync(path.join(ART, 'sites_probe.json'), JSON.stringify(out, null, 2));

  console.log('=== PAGE RESULTS ===');
  for (const [u, r] of Object.entries(results)) {
    console.log(`\n${u}\n  status=${r.status} title="${r.title}" newReqs=${r.newRequests} controls=${r.controls.length}`);
    r.controls.slice(0, 12).forEach(c => console.log(`   [${c.tag}] ${c.id || '-'} | "${c.text}" | ${c.href || c.onclick}`));
  }
  console.log('\n=== INTERESTING REQUESTS ===');
  console.log([...interesting].join('\n') || '(none)');
  console.log(`\nTotal requests: ${reqs.length}. Full dump -> artifacts/sites_probe.json`);

  await browser.close();
})();
