const { chromium } = require('playwright');

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);

  // 1) Fresh load = just counties (one layer row, no dynamic seeds).
  const rows = await page.$$eval('.layer-item', els => els.map(e => e.dataset.layerId));
  console.log('layer rows on fresh load:', rows);

  // 2) Add Data button is just "+".
  const addBtnText = await page.$eval('#add-data-btn', b => b.textContent.trim());
  console.log('add-data-btn text:', JSON.stringify(addBtnText));

  // 3) Open catalog; nothing marked in-map yet.
  await page.click('#add-data-btn');
  await page.waitForTimeout(400);
  const firstAddText = await page.$eval('.catalog-item .catalog-add', b => b.textContent.trim());
  const inMapBefore = await page.$$eval('.catalog-item.in-map', els => els.length);
  console.log('first button label:', JSON.stringify(firstAddText), '| in-map items before:', inMapBefore);

  // 4) Click Add on first indicator -> becomes Remove + row marked in-map.
  await page.click('.catalog-item .catalog-add');
  await page.waitForTimeout(500);
  const afterAdd = await page.$eval('.catalog-item .catalog-add', b => ({
    text: b.textContent.trim(), remove: b.classList.contains('remove'),
    inMap: b.closest('.catalog-item').classList.contains('in-map')
  }));
  console.log('after Add -> button:', JSON.stringify(afterAdd));

  // 5) Layer now present in the Layers panel.
  const rowsAfterAdd = await page.$$eval('.layer-item', els => els.length);
  console.log('layer rows after add:', rowsAfterAdd);

  // 6) Click Remove -> back to Add, row unmarked, layer gone.
  await page.click('.catalog-item .catalog-add.remove');
  await page.waitForTimeout(500);
  const afterRemove = await page.$eval('.catalog-item .catalog-add', b => ({
    text: b.textContent.trim(), remove: b.classList.contains('remove')
  }));
  const rowsAfterRemove = await page.$$eval('.layer-item', els => els.length);
  console.log('after Remove -> button:', JSON.stringify(afterRemove), '| layer rows:', rowsAfterRemove);

  // 7) Reopen catalog reflects current (removed) state.
  await page.click('.catalog-close');
  await page.waitForTimeout(200);
  await page.click('#add-data-btn');
  await page.waitForTimeout(300);
  const reopenInMap = await page.$$eval('.catalog-item.in-map', els => els.length);
  console.log('in-map items after reopen (should be 0):', reopenInMap);

  await page.screenshot({ path: 'artifacts/addremove.png' });
  console.log('\nCONSOLE ERRORS:', errors.length ? errors : 'none');
  await browser.close();
})();
