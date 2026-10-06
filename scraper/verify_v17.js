const { chromium } = require('playwright');

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const log = (...a) => console.log(...a);

  await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);

  // Add the first indicator (a polygon choropleth) from the catalog.
  await page.click('#add-data-btn');
  await page.waitForTimeout(400);
  await page.click('.catalog-item .catalog-add');
  await page.waitForTimeout(700);
  await page.click('.catalog-close');
  await page.waitForTimeout(300);

  const dynId = await page.$$eval('.layer-item', els => {
    const d = els.find(e => /^dyn_/.test(e.dataset.layerId));
    return d ? d.dataset.layerId : null;
  });
  log('dynamic layer id:', dynId);
  const row = `.layer-item[data-layer-id="${dynId}"]`;

  // Reveal the style options (gear toggles .show-opts).
  await page.click(`${row} .opts-btn`);
  await page.waitForTimeout(250);

  // Choose the diagonal fill pattern.
  await page.click(`${row} .pat-swatch.pat-diagonal`);
  await page.waitForTimeout(400);
  const diagActive = await page.$eval(`${row} .pat-swatch.pat-diagonal`, b => b.classList.contains('active'));
  log('diagonal pattern active:', diagActive);

  // Pattern-opacity slider present.
  const patSlider = `${row} .pat-opacity-wrap input[type="range"]`;
  const hasPatSlider = !!(await page.$(patSlider));
  log('pattern-opacity slider present:', hasPatSlider);

  // Drive LAYER opacity -> 0 (fill vanishes), then PATTERN opacity -> 0.5 (hatch stays).
  await page.$eval(`${row} .opacity-row input[type="range"]`,
    el => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(250);
  await page.$eval(patSlider,
    el => { el.value = '0.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(300);

  const layerOpVal = await page.$eval(`${row} .opacity-row .opacity-val`, e => e.textContent.trim());
  const patOpVal = await page.$eval(`${row} .pat-opacity-wrap .opacity-val`, e => e.textContent.trim());
  log('layer opacity label:', layerOpVal, '| pattern opacity label:', patOpVal);

  await page.screenshot({ path: 'artifacts/pattern_opacity.png' });

  // Persist + reload: pattern opacity should survive (saved map restore).
  await page.click('.tb-map-btn');
  await page.waitForTimeout(150);
  await page.click('.tb-menu.open >> text=Save Map');
  await page.waitForTimeout(300);
  await page.fill('.savemap-name', 'Pattern Opacity Test');
  await page.click('.savemap-primary[data-act="save"]');
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);

  const dynId2 = await page.$$eval('.layer-item', els => {
    const d = els.find(e => /^dyn_/.test(e.dataset.layerId));
    return d ? d.dataset.layerId : null;
  });
  await page.click(`.layer-item[data-layer-id="${dynId2}"] .opts-btn`);
  await page.waitForTimeout(250);
  const patOpAfter = await page.$eval(
    `.layer-item[data-layer-id="${dynId2}"] .pat-opacity-wrap input[type="range"]`, e => e.value);
  log('pattern opacity value after save+reload:', patOpAfter);

  log('\nCONSOLE ERRORS:', errors.length ? errors : 'none');
  await browser.close();
})();
