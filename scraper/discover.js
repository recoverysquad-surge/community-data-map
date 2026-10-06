// Discovery script: inspect the SAVI Advanced Search DOM so we can build an
// accurate scraper. Prints dropdowns, buttons, nav tabs, hidden fields, and
// saves a screenshot + full HTML for offline inspection.
const { chromium } = require('playwright');
const fs = require('fs');

const START_URL =
  'https://classic.savi.org/savi/AdvancedSearch/ServiceArea.aspx?SelectGeography=TRACT2010&RefLayerID=282&SelectedGeos=&Mode=true';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();

  // Log every network request that looks data-bearing.
  const dataCalls = [];
  page.on('request', req => {
    const u = req.url();
    if (/LocalServices|\.ashx|\.asmx|GetGeo|GetData|Download|Service/i.test(u)) {
      dataCalls.push(`${req.method()} ${u}`);
    }
  });

  console.log('Navigating:', START_URL);
  await page.goto(START_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log('goto warn:', e.message));

  // --- Dropdowns / selects ---
  const selects = await page.$$eval('select', els => els.map(s => ({
    id: s.id, name: s.name,
    options: Array.from(s.options).slice(0, 12).map(o => `${o.value}=${o.textContent.trim()}`)
  })));
  console.log('\n=== SELECTS ===');
  console.log(JSON.stringify(selects, null, 2));

  // --- Buttons / submit inputs / action links ---
  const buttons = await page.$$eval('button, input[type=button], input[type=submit], a[href*="__doPostBack"], a.rmLink, .rmText',
    els => els.slice(0, 60).map(b => ({
      tag: b.tagName, id: b.id, name: b.name || '',
      text: (b.value || b.textContent || '').trim().slice(0, 40),
      onclick: (b.getAttribute('onclick') || b.getAttribute('href') || '').slice(0, 80)
    })).filter(b => b.text));
  console.log('\n=== BUTTONS / ACTIONS (first 60) ===');
  console.log(JSON.stringify(buttons, null, 2));

  // --- Top nav "tabs" (Telerik RadMenu) ---
  const tabs = await page.$$eval('.rmItem a, .rmText, nav a, .secondary-nav a',
    els => Array.from(new Set(els.map(a => (a.textContent || '').trim()).filter(t => t && t.length < 30))));
  console.log('\n=== NAV TABS ===');
  console.log(JSON.stringify(tabs, null, 2));

  // --- Hidden state fields ---
  const hidden = await page.$$eval('input[type=hidden]', els => els.map(h => h.name).filter(Boolean));
  console.log('\n=== HIDDEN FIELDS ===');
  console.log(JSON.stringify(hidden, null, 2));

  console.log('\n=== DATA-BEARING NETWORK CALLS ===');
  console.log(dataCalls.join('\n') || '(none captured)');

  await page.screenshot({ path: 'discover_servicearea.png', fullPage: true }).catch(() => {});
  fs.writeFileSync('discover_servicearea.html', await page.content());
  console.log('\nSaved discover_servicearea.png and .html');

  await browser.close();
})();
