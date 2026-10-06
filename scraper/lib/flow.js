// Shared helpers for the SAVI Advanced Search flow.
const { chromium } = require('playwright');

const BASE = 'https://classic.savi.org/savi';
const START = `${BASE}/AdvancedSearch/ServiceArea.aspx?SelectGeography=TRACT2010&RefLayerID=282&SelectedGeos=&Mode=true`;

// Geography type -> [SAVI type token, RefLayerID] (from the Dpl dropdown values).
const GEO_TYPES = {
  BLKGRP2010: { token: 'BLKGRP2010', refId: 283, label: '2010 Blockgroups' },
  TRACT2010:  { token: 'TRACT2010',  refId: 282, label: '2010 Census Tracts' },
  COUNTY:     { token: 'COUNTY',     refId: 2,   label: 'Counties' },
  SCHLCORP:   { token: 'SCHLCORP',   refId: 55,  label: 'School Corporations' },
  TOWNSHIP:   { token: 'TOWNSHIP',   refId: 3,   label: 'Townships' },
  ZCTA2010:   { token: 'ZCTA2010',   refId: 341, label: 'ZIP Code Tabulation Areas 2010' },
  NEIGHBORHOOD: { token: '_SystemBoundary_DMD Neighborhood', refId: 0, label: 'Marion County Neighborhoods' },
};

const LDPATH = '/mnt/c/temp/SAVI/scraper/.native/root/usr/lib/x86_64-linux-gnu';

async function launch(headless = true) {
  // In an isolated user-namespace (parallel Xvfb workers) Chromium runs as namespace-root,
  // so its sandbox can't drop privileges — SAVI_NO_SANDBOX=1 passes --no-sandbox there.
  const args = process.env.SAVI_NO_SANDBOX === '1'
    ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
  const browser = await chromium.launch({ headless, args });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);
  return { browser, ctx, page };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Select a geography type in the Dpl dropdown (matches by label contains).
async function setGeographyType(page, labelContains) {
  const val = await page.$$eval('#ctl00_ContentPlaceHolder1_Dpl option',
    (opts, want) => (opts.find(o => o.textContent.toLowerCase().includes(want.toLowerCase())) || {}).value,
    labelContains);
  if (val) { await page.selectOption('#ctl00_ContentPlaceHolder1_Dpl', val); await sleep(1500); }
  return val;
}

// Inject a geo id and commit the selection to the session via MapSearch postback.
async function selectAndCommitGeo(page, geoId) {
  await page.evaluate(g => {
    const el = document.querySelector('#ctl00_ContentPlaceHolder1_SaveSelectedGeos');
    if (el) el.value = g;
  }, geoId);
  await page.click('#ctl00_ContentPlaceHolder1_MapSearch').catch(() => {});
  await page.waitForLoadState('load', { timeout: 45000 }).catch(() => {});
  await page.waitForFunction(
    () => /Search Results?\s*\(\d+\)/i.test(document.body.innerText),
    { timeout: 20000 }
  ).catch(() => {});
  let count = '?';
  for (let i = 0; i < 3; i++) {
    try { count = await page.evaluate(() => { const m = document.body.innerText.match(/Search Results?\s*\((\d+)\)/i); return m ? m[1] : '?'; }); break; }
    catch { await sleep(1200); }
  }
  return count;
}

// From the ServiceArea page, go to Select Data and return the ProjectID.
async function gotoSelectData(page) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('a[href$="SelectData.aspx"], a:has-text("Select Data")'),
  ]);
  await sleep(1500);
  return page.evaluate(() => {
    const el = document.querySelector('#addDItems, [onclick*="PopUps/SelectData.aspx"]');
    const m = el && el.getAttribute('onclick') && el.getAttribute('onclick').match(/ProjectID=(\d+)/);
    return m ? m[1] : null;
  });
}

module.exports = { BASE, START, GEO_TYPES, LDPATH, launch, sleep, setGeographyType, selectAndCommitGeo, gotoSelectData };
