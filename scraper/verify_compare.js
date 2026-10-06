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
  await page.waitForTimeout(1500);

  // 1) Compare button exists in toolbar; open the modal.
  const cmpBtn = await page.$('button.tb-btn:has-text("Compare")');
  console.log('Compare button present:', !!cmpBtn);
  await cmpBtn.click();
  await page.waitForTimeout(500);
  const modalOpen = await page.$eval('#cmp-overlay', el => el.classList.contains('open'));
  console.log('Compare modal open:', modalOpen);

  // 2) Empty state + level select populated.
  const emptyMsg = await page.$('.cmp-empty');
  const levelOpts = await page.$$eval('.cmp-level .cmp-mini option', os => os.map(o => o.value));
  console.log('empty state shown:', !!emptyMsg, '| levels:', levelOpts);

  // 3) Add two columns via the picker.
  await page.click('.cmp-primary');
  await page.waitForTimeout(400);
  const pickerOpen = await page.$('#cmp-picker-overlay.open');
  const adds = await page.$$('#cmp-picker-overlay .catalog-add');
  console.log('picker open:', !!pickerOpen, '| indicators available:', adds.length);
  await adds[0].click();
  await page.waitForTimeout(400);
  await adds[1].click();
  await page.waitForTimeout(400);
  await page.click('#cmp-picker-overlay .catalog-close');
  await page.waitForTimeout(200);

  // 4) Table has 2 data columns + a geography column, and geography rows.
  const headers = await page.$$eval('.cmp-table thead th', ths => ths.map(t => t.textContent.trim().slice(0, 30)));
  const rowCount = await page.$$eval('.cmp-table tbody tr', rs => rs.length);
  const sampleCell = await page.$eval('.cmp-table tbody tr td.cmp-val', td => td.textContent);
  console.log('header cells:', headers.length, JSON.stringify(headers));
  console.log('geography rows:', rowCount, '| sample value cell:', JSON.stringify(sampleCell));

  // 5) Heat-map shading applied to at least one value cell.
  const shaded = await page.$$eval('.cmp-table tbody td.cmp-val',
    tds => tds.filter(t => t.style.backgroundColor && t.style.backgroundColor !== '').length);
  console.log('shaded value cells:', shaded);

  // 6) Sort by first data column (click its title) — order changes.
  const firstColBefore = await page.$$eval('.cmp-table tbody tr .cmp-geo-name', ns => ns.map(n => n.textContent));
  await page.click('.cmp-table thead th.cmp-col-h .cmp-col-title');
  await page.waitForTimeout(300);
  const firstColAfter = await page.$$eval('.cmp-table tbody tr .cmp-geo-name', ns => ns.map(n => n.textContent));
  console.log('sort changed row order:', JSON.stringify(firstColBefore) !== JSON.stringify(firstColAfter));

  // 7) Change a column's Display -> values refresh (cells may change).
  const beforeVals = await page.$$eval('.cmp-table tbody tr td.cmp-val', ts => ts.slice(0, 3).map(t => t.textContent));
  const dSel = '.cmp-table thead th.cmp-col-h .cmp-col-ctrls .cmp-mini';
  const dOpts = await page.$eval(dSel, s => [...s.options].map(o => o.value));
  if (dOpts[1]) await page.selectOption(dSel, dOpts[1]);
  await page.waitForTimeout(500);
  const afterVals = await page.$$eval('.cmp-table tbody tr td.cmp-val', ts => ts.slice(0, 3).map(t => t.textContent));
  console.log('display change refreshed values:', JSON.stringify(beforeVals) !== JSON.stringify(afterVals),
    JSON.stringify(beforeVals), '->', JSON.stringify(afterVals));

  // 8) CSV download works (capture the download).
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    (async () => {
      await page.click('.cmp-menu-wrap .cmp-btn');
      await page.waitForTimeout(150);
      await page.click('.cmp-menu-item:has-text("CSV")');
    })()
  ]);
  console.log('CSV download fired:', !!dl, dl ? dl.suggestedFilename() : '');

  // 9) Remove a column.
  const colsBefore = await page.$$eval('.cmp-table thead th.cmp-col-h', c => c.length);
  await page.click('.cmp-table thead th.cmp-col-h .cmp-col-rm');
  await page.waitForTimeout(200);
  const colsAfter = await page.$$eval('.cmp-table thead th.cmp-col-h', c => c.length);
  console.log('remove column:', colsBefore, '->', colsAfter);

  await page.screenshot({ path: 'artifacts/compare.png' });
  console.log('\nCONSOLE ERRORS:', errors.length ? errors : 'none');
  await browser.close();
})();
