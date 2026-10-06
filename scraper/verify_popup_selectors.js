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
  await page.waitForTimeout(1800);

  // 1) Rows no longer contain inline selectors; they show a subtitle instead.
  const dynRows = await page.$$eval('.layer-item[data-layer-id^="dyn_"]', els => els.map(e => e.dataset.layerId));
  const inlineSelectors = await page.$$eval('.layer-item .layer-selectors', els => els.length);
  const firstRow = `.layer-item[data-layer-id="${dynRows[0]}"]`;
  const subText = await page.$eval(`${firstRow} .layer-sub`, el => el.textContent);
  console.log('dynamic rows:', dynRows.length, '| inline .layer-selectors in rows:', inlineSelectors);
  console.log('first row subtitle:', JSON.stringify(subText));

  // 2) Open the popup via the adjust button.
  await page.click(`${firstRow} .adj-btn`);
  await page.waitForTimeout(300);
  const popExists = await page.$(`#sel-popup-${dynRows[0]}`);
  const popSelects = await page.$$eval(`#sel-popup-${dynRows[0]} .layer-select`, els => els.length);
  console.log('popup opened:', !!popExists, '| selects in popup:', popSelects);

  // 3) Clicking adjust again does NOT open a second popup.
  await page.click(`${firstRow} .adj-btn`);
  await page.waitForTimeout(150);
  const popCount = await page.$$eval('.sel-popup', els => els.length);
  console.log('popups after second click (should be 1):', popCount);

  // 4) Change Display in the popup -> map/legend recolor + subtitle updates.
  const legendBefore = await page.$eval('#legend', el => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 90));
  const dispSel = `#sel-popup-${dynRows[0]} .sel-group:nth-child(2) .layer-select`;
  const dispOpts = await page.$eval(dispSel, s => [...s.options].map(o => o.value));
  if (dispOpts[1]) await page.selectOption(dispSel, dispOpts[1]);
  await page.waitForTimeout(600);
  const subAfter = await page.$eval(`${firstRow} .layer-sub`, el => el.textContent);
  const legendAfter = await page.$eval('#legend', el => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 90));
  console.log('subtitle after change:', JSON.stringify(subAfter));
  console.log('legend changed:', legendBefore !== legendAfter);

  // 5) Drag the popup by its header to a new spot.
  const box = await page.$eval(`#sel-popup-${dynRows[0]}`, el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  const hb = await page.$eval(`#sel-popup-${dynRows[0]} .sel-popup-header`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(hb.x, hb.y);
  await page.mouse.down();
  await page.mouse.move(hb.x + 160, hb.y + 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const box2 = await page.$eval(`#sel-popup-${dynRows[0]}`, el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  console.log('popup moved:', Math.abs(box2.x - box.x) > 100 && Math.abs(box2.y - box.y) > 80, `(${Math.round(box.x)},${Math.round(box.y)} -> ${Math.round(box2.x)},${Math.round(box2.y)})`);

  // 6) Close the popup.
  await page.click(`#sel-popup-${dynRows[0]} .sel-popup-close`);
  await page.waitForTimeout(150);
  const gone = await page.$(`#sel-popup-${dynRows[0]}`);
  console.log('popup closed:', !gone);

  // 7) Delete a layer with popup open -> popup pruned.
  await page.click(`${firstRow} .adj-btn`);
  await page.waitForTimeout(150);
  await page.click(`${firstRow} .del-btn`);
  await page.waitForTimeout(300);
  const prunedPopup = await page.$(`#sel-popup-${dynRows[0]}`);
  console.log('popup pruned on delete:', !prunedPopup);

  console.log('\nCONSOLE ERRORS:', errors.length ? errors : 'none');
  await page.screenshot({ path: 'artifacts/popup_selectors.png' });
  await browser.close();
})();
