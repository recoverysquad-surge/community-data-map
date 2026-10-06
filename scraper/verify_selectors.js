const { chromium } = require('playwright');

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);

  // 1) Seeded dynamic layers present?
  const dynRows = await page.$$eval('.layer-item[data-layer-id^="dyn_"]', els => els.map(e => e.dataset.layerId));
  console.log('seeded dynamic layers:', dynRows.length, dynRows);

  // 2) Inspect first dynamic layer's selectors.
  const firstRow = `.layer-item[data-layer-id="${dynRows[0]}"]`;
  const selInfo = await page.$eval(firstRow, row => {
    const sels = [...row.querySelectorAll('.layer-select')];
    return sels.map(s => ({
      label: s.previousElementSibling.textContent,
      options: [...s.options].map(o => o.textContent),
      value: s.options[s.selectedIndex].textContent
    }));
  });
  console.log('selectors on first dynamic layer:');
  selInfo.forEach(s => console.log('   ', s.label, '=', s.value, '| options:', s.options.join(', ')));

  // 3) Legend before change.
  const legendBefore = await page.$eval('#legend', el => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120));

  // 4) Change Display to a concrete value (2nd option after Any), then Year.
  const displaySelSel = `${firstRow} .sel-group:nth-child(2) .layer-select`;
  const dispOptions = await page.$eval(displaySelSel, s => [...s.options].map(o => o.value));
  if (dispOptions[1]) await page.selectOption(displaySelSel, dispOptions[1]);
  await page.waitForTimeout(400);
  const yearSelSel = `${firstRow} .sel-group:nth-child(3) .layer-select`;
  const yearOptions = await page.$eval(yearSelSel, s => [...s.options].map(o => o.value));
  if (yearOptions[1]) await page.selectOption(yearSelSel, yearOptions[1]);
  await page.waitForTimeout(500);
  const legendAfter = await page.$eval('#legend', el => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120));
  console.log('\nlegend changed after selection:', legendBefore !== legendAfter);
  console.log('  before:', legendBefore);
  console.log('  after :', legendAfter);

  // 5) Add Data modal: open, search, add.
  await page.click('#add-data-btn');
  await page.waitForTimeout(300);
  const modalOpen = await page.$eval('#catalog-overlay', el => el.classList.contains('open'));
  await page.fill('.catalog-search', 'Domestic Violence');
  await page.waitForTimeout(300);
  const itemCount = await page.$$eval('.catalog-item', els => els.length);
  console.log('\nmodal open:', modalOpen, '| items matching "Domestic Violence":', itemCount);
  const rowsBefore = await page.$$eval('.layer-item', els => els.length);
  await page.click('.catalog-item .catalog-add');
  await page.waitForTimeout(600);
  // close modal
  await page.click('.catalog-close');
  await page.waitForTimeout(300);
  const rowsAfterAdd = await page.$$eval('.layer-item', els => els.length);
  console.log('layer rows before add:', rowsBefore, '-> after add:', rowsAfterAdd);

  // 6) Delete the first dynamic layer.
  await page.click(`${firstRow} .del-btn`);
  await page.waitForTimeout(400);
  const stillThere = await page.$(firstRow);
  const rowsAfterDel = await page.$$eval('.layer-item', els => els.length);
  console.log('deleted first dynamic layer; row gone:', !stillThere, '| rows now:', rowsAfterDel);

  console.log('\nCONSOLE ERRORS:', errors.length ? errors : 'none');
  await page.screenshot({ path: 'artifacts/selectors.png' });
  await browser.close();
})();
