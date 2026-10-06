// Explore the "add items" data-item picker popup (/savi/PopUps/SelectData.aspx).
// Runs the confirmed flow to Select Data, grabs the ProjectID, opens the popup in
// the same session, and dumps its structure (search box, tree, buttons) + screenshot.
const { chromium } = require('playwright');
const fs = require('fs');

const START = 'https://classic.savi.org/savi/AdvancedSearch/ServiceArea.aspx?SelectGeography=TRACT2010&RefLayerID=282&SelectedGeos=&Mode=true';
const GEOID = '18097391000';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.setDefaultTimeout(60000);

  // Steps 1-4 (known-good): select tract, commit, go to Select Data.
  await page.goto(START, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ctl00_ContentPlaceHolder1_Dpl');
  const optVal = await page.$$eval('#ctl00_ContentPlaceHolder1_Dpl option',
    o => (o.find(x => /census tract/i.test(x.textContent)) || {}).value);
  await page.selectOption('#ctl00_ContentPlaceHolder1_Dpl', optVal);
  await page.waitForTimeout(2000);
  await page.evaluate(g => document.querySelector('#ctl00_ContentPlaceHolder1_SaveSelectedGeos').value = g, GEOID);
  await page.click('#ctl00_ContentPlaceHolder1_MapSearch').catch(() => {});
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForFunction(() => /Search Results?\s*\(\d+\)/i.test(document.body.innerText), { timeout: 20000 }).catch(() => {});
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('a[href$="SelectData.aspx"], a:has-text("Select Data")'),
  ]);
  await page.waitForTimeout(2000);

  // Grab the ProjectID from the "add +" onclick.
  const projectId = await page.evaluate(() => {
    const el = document.querySelector('#addDItems, [onclick*="PopUps/SelectData.aspx"]');
    const m = el && el.getAttribute('onclick').match(/ProjectID=(\d+)/);
    return m ? m[1] : null;
  });
  console.log('ProjectID =', projectId);

  const popupUrl = `https://classic.savi.org/savi/PopUps/SelectData.aspx?Originator=&ProjectID=${projectId || ''}`;
  console.log('Opening popup:', popupUrl);
  await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // Dump structure of the picker.
  const inputs = await page.$$eval('input, textarea', els => els.slice(0, 40).map(e => ({
    type: e.type, id: e.id, name: e.name, value: (e.value || '').slice(0, 30)
  })).filter(e => e.id || e.name));
  console.log('\n=== INPUTS ===\n', JSON.stringify(inputs, null, 2));

  const buttons = await page.$$eval('button, input[type=button], input[type=submit], a',
    els => els.slice(0, 50).map(b => ({ tag: b.tagName, id: b.id, text: (b.value || b.textContent || '').trim().slice(0, 30) }))
      .filter(b => b.text && b.text.length < 30));
  console.log('\n=== BUTTONS/LINKS ===\n', JSON.stringify(buttons.slice(0, 40), null, 2));

  // Tree nodes (Telerik RadTreeView or similar).
  const tree = await page.$$eval('.rtLink, .rtText, [id*="Tree"] a, [id*="tree"] a, li a',
    els => Array.from(new Set(els.map(a => (a.textContent || '').trim()).filter(t => t && t.length < 40))).slice(0, 40));
  console.log('\n=== TREE/LIST NODES (first 40) ===\n', JSON.stringify(tree, null, 2));

  await page.screenshot({ path: 'artifacts/explore_popup.png', fullPage: true });
  fs.writeFileSync('artifacts/explore_popup.html', await page.content());
  console.log('\nSaved artifacts/explore_popup.png/.html');
  await browser.close();
})();
