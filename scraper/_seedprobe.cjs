// Diagnostic: for each non-County level, set the geography type + inject the seed geoId,
// commit via MapSearch, and report the "Search Results (N)" count. N>=1 == seed is valid
// for that level; N==0 (or '?') == the seed/type binding is wrong -> grid would be empty.
const { START, launch, setGeographyType, selectAndCommitGeo } = require('./lib/flow');

const TARGETS = [
  { level: '2010 Blockgroup', geoTypeLabel: '2010 Blockgroups', seedGeoId: '180973910003' },
  { level: 'Township', geoTypeLabel: 'Townships', seedGeoId: '1809711512' },
  { level: 'School Corporation', geoTypeLabel: 'School Corporations', seedGeoId: '5385' },
  { level: 'ZIP', geoTypeLabel: 'ZIP Code Tabulation Areas 2010', seedGeoId: '46204' },
  { level: 'MSA', geoTypeLabel: 'Counties', seedGeoId: '18097' },
];

(async () => {
  const { browser, page } = await launch(true);
  for (const t of TARGETS) {
    try {
      await page.goto(START, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#ctl00_ContentPlaceHolder1_Dpl');
      const val = await setGeographyType(page, t.geoTypeLabel);
      const count = await selectAndCommitGeo(page, t.seedGeoId);
      console.log(`${t.level.padEnd(20)} geoType="${t.geoTypeLabel}" dplVal=${val || 'NONE'} seed=${t.seedGeoId} -> Search Results (${count})`);
    } catch (e) {
      console.log(`${t.level.padEnd(20)} ERROR ${e.message}`);
    }
  }
  await browser.close();
})();
