const { chromium } = require('playwright');

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // Start clean (no saved map) so defaults load.
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Open the counties row gear, then click the crosshatch pattern swatch.
  const row = 'div.layer-item[data-layer-id="counties"]';
  await page.click(`${row} .opts-btn`);
  await page.waitForTimeout(200);
  await page.click(`${row} .pat-swatch.pat-crosshatch`);
  await page.waitForTimeout(500);

  // Read the row chip background-image.
  const chipBg = await page.$eval(`${row} .layer-item-row .layer-chip`,
    el => getComputedStyle(el).backgroundImage);

  // Read the legend swatch for counties (its legend block).
  const legendBg = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.legend-block')];
    const b = blocks.find(x => x.textContent.includes('Counties') || x.textContent.includes('County'));
    if (!b) return { found: false };
    const sw = b.querySelector('.legend-swatch');
    return { found: true, bg: sw ? getComputedStyle(sw).backgroundImage : '(no swatch)' };
  });

  console.log('errors:', errors.length ? errors : 'none');
  console.log('row chip backgroundImage:', chipBg);
  console.log('legend swatch:', JSON.stringify(legendBg));

  await page.screenshot({ path: 'artifacts/pattern_legend.png' });
  await browser.close();
})();
