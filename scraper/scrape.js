/*
 * SAVI Advanced Search — Playwright scraper PROTOTYPE (one geography).
 * -------------------------------------------------------------------
 * Walks the real classic.savi.org Advanced Search flow for a SINGLE geography
 * and dumps the resulting data table(s) to CSV.
 *
 * Flow (reverse-engineered from the live pages):
 *   1. Open ServiceArea.aspx (the "pick a service area" step).
 *   2. Set the geography-type dropdown (#..._Dpl) to Census Tract.
 *   3. Select ONE geography. Two supported methods:
 *        - "address": type an address + click Find  (most automatable — no map pixels)
 *        - "geoid":   inject a known geo id straight into the hidden SaveSelectedGeos field
 *      Either way the selection lands in the hidden field ..._SaveSelectedGeos and,
 *      on the postback, is stored in the ASP.NET session.
 *   4. Click the "Select Data" link  -> SelectData.aspx.
 *   5. Check the configured indicator(s) in the keyword tree.
 *   6. Go to the Tables view -> Table.aspx.
 *   7. Scrape the rendered grid(s) to CSV.
 *
 * WHY a browser (not requests): the data grids are rendered by ASP.NET WebForms
 * / Telerik postbacks tied to session state — there is no direct JSON/CSV API
 * (DownloadData.aspx is disabled). Playwright carries the session + VIEWSTATE for free.
 *
 * IMPORTANT: steps 5-6 (indicator tree + results grid) only render with a live
 * session, so their exact selectors could not be confirmed offline. This script
 * uses resilient, label-based matching and GENERIC table extraction, and it saves
 * a screenshot + HTML snapshot at every step under ./artifacts so you can confirm
 * or tune selectors from a single real run. Run `node discover.js` first to dump
 * live structure if anything needs adjusting.
 *
 * Usage:
 *   node scrape.js                      # uses CONFIG defaults below
 *   HEADLESS=false node scrape.js       # watch it run (needs a display / xvfb)
 *
 * Prereq (one-time, needs sudo — see README): install browser system libs.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ----------------------------- CONFIG -----------------------------
const CONFIG = {
  startUrl:
    'https://classic.savi.org/savi/AdvancedSearch/ServiceArea.aspx?SelectGeography=TRACT2010&RefLayerID=282&SelectedGeos=&Mode=true',

  // How to pick the single geography: 'geoid' (reliable) or 'address'.
  selectionMode: 'geoid',

  // For selectionMode 'address' — an address inside the target tract.
  address: { street: '40 E St Clair St', city: 'Indianapolis', zip: '46204' },

  // For selectionMode 'geoid' — a known SAVI geo id (gi) to inject directly.
  // 18097391000 = Marion County census tract 3910 (fetched via GetGeoSelections point lookup).
  geoId: '18097391000',

  // Text shown in the geography-type dropdown option we want (case-insensitive contains).
  geographyOptionText: 'Census Tract',

  // Indicator labels to check in the Select Data keyword tree (case-insensitive contains).
  indicators: ['Total Population'],

  headless: process.env.HEADLESS !== 'false',
  outCsv: 'savi_output.csv',
  artifactsDir: 'artifacts',
  navTimeout: 60000,
};

// Confirmed control IDs (mined from the live page markup).
const SEL = {
  geoDropdown: '#ctl00_ContentPlaceHolder1_Dpl',
  addrStreet: '#ctl00_ContentPlaceHolder1_tbAddress',
  addrCity: '#ctl00_ContentPlaceHolder1_tbCity',
  addrZip: '#ctl00_ContentPlaceHolder1_tbZip',
  findBtn: '#ctl00_ContentPlaceHolder1_btnFind',
  // Bottom "Search" button — commits the current map/geo selection to the session.
  mapSearchBtn: '#ctl00_ContentPlaceHolder1_MapSearch',
  savedGeos: '#ctl00_ContentPlaceHolder1_SaveSelectedGeos',
  // "Select Data" appears as a plain link in the step nav.
  selectDataLink: 'a[href$="SelectData.aspx"], a:has-text("Select Data")',
  tablesNav: 'a[href$="Table.aspx"], a[href$="Tables.aspx"], a:has-text("Tables")',
};
// -------------------------------------------------------------------

let stepNo = 0;
function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

async function snapshot(page, name) {
  const base = path.join(CONFIG.artifactsDir, `${String(++stepNo).padStart(2, '0')}_${name}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  fs.writeFileSync(`${base}.html`, await page.content());
  log(`  snapshot -> ${base}.png / .html`);
}

// Generic table extractor: pulls every data-bearing <table> (incl. Telerik RadGrid)
// into arrays of rows. Skips tiny layout tables.
async function extractTables(page) {
  return page.$$eval('table', tables => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const t of tables) {
      const rows = Array.from(t.querySelectorAll('tr'));
      if (rows.length < 2) continue;
      const grid = rows.map(r =>
        Array.from(r.querySelectorAll('th,td')).map(c => clean(c.textContent))
      ).filter(r => r.some(c => c.length));
      // Heuristic: keep tables that look like data (>=2 cols, >=2 rows, some numbers).
      const flat = grid.flat().join(' ');
      const looksLikeData = grid.length >= 2 && grid[0].length >= 2 && /\d/.test(flat) && flat.length > 40;
      if (looksLikeData) out.push({ id: t.id || '(anon)', rows: grid });
    }
    return out;
  });
}

function toCsv(rows) {
  return rows.map(r =>
    r.map(cell => {
      const s = String(cell ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  ).join('\n');
}

(async () => {
  fs.mkdirSync(CONFIG.artifactsDir, { recursive: true });
  const browser = await chromium.launch({ headless: CONFIG.headless });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(CONFIG.navTimeout);

  // Track the geo-selection XHR so we know a geography was actually picked.
  let geoSelected = false;
  page.on('response', async resp => {
    if (/GetGeoSelections\.aspx/i.test(resp.url())) {
      const body = await resp.text().catch(() => '');
      if (/<polygon/i.test(body)) geoSelected = true;
    }
  });

  try {
    // --- Step 1: load service-area page ---
    log('Step 1: loading ServiceArea.aspx');
    await page.goto(CONFIG.startUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SEL.geoDropdown, { timeout: CONFIG.navTimeout });
    await snapshot(page, 'servicearea_loaded');

    // --- Step 2: choose geography type = Census Tract ---
    log(`Step 2: selecting geography type containing "${CONFIG.geographyOptionText}"`);
    const optValue = await page.$$eval(
      `${SEL.geoDropdown} option`,
      (opts, want) => {
        const m = opts.find(o => o.textContent.toLowerCase().includes(want.toLowerCase()));
        return m ? m.value : null;
      },
      CONFIG.geographyOptionText
    );
    if (optValue) {
      await page.selectOption(SEL.geoDropdown, optValue);
      // The dropdown's onchange runs SetQueryGeoSelectionType(); give the map a beat.
      await page.waitForTimeout(2500);
    } else {
      log('  WARN: no matching geography option found; continuing with default.');
    }
    await snapshot(page, 'geography_type_set');

    // --- Step 3: select ONE geography ---
    if (CONFIG.selectionMode === 'address') {
      log('Step 3: selecting geography by address + Find');
      await page.fill(SEL.addrStreet, CONFIG.address.street).catch(() => {});
      await page.fill(SEL.addrCity, CONFIG.address.city).catch(() => {});
      await page.fill(SEL.addrZip, CONFIG.address.zip).catch(() => {});
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.click(SEL.findBtn),
      ]);
      await page.waitForTimeout(3000);
    } else if (CONFIG.selectionMode === 'geoid') {
      log(`Step 3: injecting geoId ${CONFIG.geoId} into SaveSelectedGeos`);
      await page.evaluate(({ sel, gid }) => {
        const el = document.querySelector(sel);
        if (el) el.value = (el.value ? el.value + ',' : '') + gid;
      }, { sel: SEL.savedGeos, gid: CONFIG.geoId });
    }

    const savedBefore = await page.inputValue(SEL.savedGeos).catch(() => '');
    log(`  SaveSelectedGeos (pre-commit) = "${savedBefore}"`);

    // Commit the selection to the session via the bottom "Search" (MapSearch)
    // postback. This is a full-page ASP.NET postback; wait for the reload to settle
    // before touching the page (avoids "execution context destroyed" races).
    log('Step 3b: committing selection (MapSearch postback)');
    await page.click(SEL.mapSearchBtn).catch(() => {});
    await page.waitForLoadState('load', { timeout: 45000 }).catch(() => {});
    await page.waitForFunction(
      () => /Search Results?\s*\(\d+\)/i.test(document.body.innerText),
      { timeout: 20000 }
    ).catch(() => {});

    // Read the committed results count (defensive: tolerate a late nav).
    let count = '?';
    for (let i = 0; i < 3; i++) {
      try {
        count = await page.evaluate(() => {
          const m = document.body.innerText.match(/Search Results?\s*\((\d+)\)/i);
          return m ? m[1] : '?';
        });
        break;
      } catch { await page.waitForTimeout(1500); }
    }
    log(`  Search Results count = ${count}`);
    await snapshot(page, 'geography_selected');
    if (count === '0') {
      log('  WARN: 0 results. Inspect artifacts/03_geography_selected.* and adjust geoId/address.');
    }

    // --- Step 4: proceed to Select Data ---
    log('Step 4: clicking "Select Data"');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.click(SEL.selectDataLink),
    ]);
    await page.waitForTimeout(2000);
    await snapshot(page, 'selectdata_loaded');

    // --- Step 5: check indicator(s) in the keyword tree ---
    // Selectors here vary with session content; match by visible label text.
    log(`Step 5: selecting indicators: ${CONFIG.indicators.join(', ')}`);
    for (const ind of CONFIG.indicators) {
      const clicked = await page.evaluate(name => {
        const wanted = name.toLowerCase();
        // Find a label/anchor/span whose text matches, then toggle its nearby checkbox.
        const nodes = Array.from(document.querySelectorAll('label, a, span, td'));
        const hit = nodes.find(n => (n.textContent || '').trim().toLowerCase().includes(wanted));
        if (!hit) return false;
        const box = hit.closest('tr, li, div')?.querySelector('input[type=checkbox]')
          || hit.querySelector('input[type=checkbox]');
        if (box) { box.click(); return true; }
        hit.click(); // fall back to clicking the label itself
        return true;
      }, ind);
      log(`  indicator "${ind}": ${clicked ? 'clicked' : 'NOT FOUND (tune in artifacts/04_*)'}`);
      await page.waitForTimeout(1000);
    }
    await snapshot(page, 'indicators_selected');

    // --- Step 6: go to Tables view ---
    log('Step 6: navigating to Tables');
    const tablesEl = await page.$(SEL.tablesNav);
    if (tablesEl) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
        tablesEl.click(),
      ]);
    } else {
      await page.goto('https://classic.savi.org/savi/Table.aspx', { waitUntil: 'domcontentloaded' });
    }
    await page.waitForTimeout(3000);
    await snapshot(page, 'tables_loaded');

    // --- Step 7: extract + write CSV ---
    log('Step 7: extracting tables');
    const tables = await extractTables(page);
    log(`  found ${tables.length} data-like table(s)`);
    if (tables.length) {
      // Write the largest table (most rows) as the primary CSV; dump all as JSON.
      tables.sort((a, b) => b.rows.length - a.rows.length);
      fs.writeFileSync(CONFIG.outCsv, toCsv(tables[0].rows));
      fs.writeFileSync(path.join(CONFIG.artifactsDir, 'all_tables.json'), JSON.stringify(tables, null, 2));
      log(`  wrote ${tables[0].rows.length} rows -> ${CONFIG.outCsv}`);
      log(`  (all tables also in ${CONFIG.artifactsDir}/all_tables.json)`);
    } else {
      log('  No data tables detected. Check artifacts/07_tables_loaded.* — the grid may');
      log('  need an indicator selected first, or a different results nav link.');
    }

    log('DONE.');
  } catch (err) {
    log(`ERROR: ${err.message}`);
    await snapshot(page, 'error_state').catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
