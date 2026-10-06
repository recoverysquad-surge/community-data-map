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

  // (13) Add-layer button is now an icon (contains an <svg>), not a bare "+".
  const hasSvg = await page.$eval('#add-data-btn', b => !!b.querySelector('svg'));
  const btnText = await page.$eval('#add-data-btn', b => b.textContent.trim());
  log('add-data-btn has svg icon:', hasSvg, '| text:', JSON.stringify(btnText));

  // Fresh load = counties only.
  let rows = await page.$$eval('.layer-item', els => els.map(e => e.dataset.layerId));
  log('fresh rows:', rows);

  // Add the first indicator from the catalog.
  await page.click('#add-data-btn');
  await page.waitForTimeout(400);
  await page.click('.catalog-item .catalog-add');
  await page.waitForTimeout(600);
  await page.click('.catalog-close');
  await page.waitForTimeout(300);
  rows = await page.$$eval('.layer-item', els => els.map(e => e.dataset.layerId));
  log('rows after add:', rows);

  // (14) Subtitle tooltip carries the FULL selection summary.
  const subInfo = await page.$eval('.layer-item .layer-sub', el => ({
    text: el.textContent.trim(), title: el.getAttribute('title')
  }));
  const tooltipOk = subInfo.title.startsWith(subInfo.text) && /click to adjust variables/.test(subInfo.title);
  log('subtitle tooltip full-text ok:', tooltipOk, '| title:', JSON.stringify(subInfo.title));

  // (15) Variables popup title shows the layer's style chip.
  await page.click('.layer-item .adj-btn');
  await page.waitForTimeout(400);
  const popupChip = await page.$eval('.sel-popup .sel-popup-header', h => ({
    hasChip: !!h.querySelector('.sel-popup-chip'),
    title: (h.querySelector('.sel-popup-title') || {}).textContent
  }));
  log('popup header has chip:', popupChip.hasChip, '| title:', JSON.stringify(popupChip.title));
  await page.click('.sel-popup .sel-popup-close');
  await page.waitForTimeout(200);

  // (16) Compare auto-loads the visible indicator layer as a column.
  await page.click('#toolbar >> text=Compare');
  await page.waitForTimeout(700);
  const autoCols = await page.$$eval('.cmp-col-h .cmp-col-title', els => els.map(e => e.textContent.trim()));
  log('Compare auto-loaded columns:', autoCols);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // (12) Save the map with a name + description.
  await page.click('.tb-map-btn');
  await page.waitForTimeout(150);
  await page.click('.tb-menu.open >> text=Save Map');
  await page.waitForTimeout(300);
  await page.fill('.savemap-name', 'My Test Map');
  await page.fill('.savemap-desc', 'Mental health calls, counties');
  await page.click('.savemap-primary[data-act="save"]');
  await page.waitForTimeout(300);

  // Reload — the active saved map should auto-restore (counties + 1 dynamic layer).
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);
  rows = await page.$$eval('.layer-item', els => els.map(e => e.dataset.layerId));
  log('rows after save+reload (restored):', rows);

  // Compare after reload still auto-loads the restored layer.
  await page.click('#toolbar >> text=Compare');
  await page.waitForTimeout(700);
  const autoCols2 = await page.$$eval('.cmp-col-h .cmp-col-title', els => els.map(e => e.textContent.trim()));
  log('Compare auto columns after reload:', autoCols2);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Saved Maps list shows the entry with a "current" badge.
  await page.click('.tb-map-btn');
  await page.waitForTimeout(150);
  await page.click('.tb-menu.open >> text=Saved Maps');
  await page.waitForTimeout(300);
  const listInfo = await page.$$eval('.savemap-row', rows => rows.map(r => ({
    name: (r.querySelector('.savemap-row-name') || {}).textContent,
    desc: (r.querySelector('.savemap-row-desc') || {}).textContent,
    current: !!r.querySelector('.savemap-badge'),
    active: r.classList.contains('active')
  })));
  log('saved-maps list:', JSON.stringify(listInfo));

  await page.screenshot({ path: 'artifacts/savedmaps.png' });

  // Delete it -> list becomes empty.
  await page.click('.savemap-row .savemap-iconbtn[data-act="del"]');
  await page.waitForTimeout(300);
  const emptyText = await page.$eval('.savemap-list', el => el.textContent.trim());
  log('after delete, list empty msg present:', /No saved maps yet/.test(emptyText));

  log('\nCONSOLE ERRORS:', errors.length ? errors : 'none');
  await browser.close();
})();
