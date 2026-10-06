const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);

  // Add two indicator layers so Compare auto-loads a couple columns.
  await page.click('#add-data-btn'); await page.waitForTimeout(400);
  const addBtns = await page.$$('.catalog-item .catalog-add');
  if (addBtns[0]) await addBtns[0].click();
  await page.waitForTimeout(500);
  if (addBtns[1]) await addBtns[1].click();
  await page.waitForTimeout(500);
  await page.click('.catalog-close'); await page.waitForTimeout(300);

  await page.click('#toolbar >> text=Compare');
  await page.waitForTimeout(900);
  // Add a third column via the picker for good measure.
  await page.click('.cmp-btn.cmp-primary'); await page.waitForTimeout(400);
  const pick = await page.$$('#cmp-picker-overlay .catalog-add');
  if (pick[2]) await pick[2].click();
  await page.waitForTimeout(500);
  await page.click('#cmp-picker-overlay .catalog-close'); await page.waitForTimeout(400);

  await page.screenshot({ path: 'artifacts/compare_before.png' });
  // Also scroll the table body to check sticky header/column alignment.
  await page.$eval('.cmp-table-wrap', el => { el.scrollTop = 120; el.scrollLeft = 60; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'artifacts/compare_before_scrolled.png' });

  console.log('columns:', await page.$$eval('.cmp-col-h .cmp-col-title', els => els.map(e => e.textContent.trim())));
  console.log('ERRORS:', errs.length ? errs : 'none');
  await browser.close();
})();
