// Parse the SAVI data popup (popups/table.aspx) response into tidy rows.
// The data grid is a Telerik RadGrid: <table class="rgMasterTable" ...>
//   thead: <th class="rgHeader"> cells — first two are blank (the geography Name and
//          ID columns), the rest carry each indicator's COLUMN LABEL (year prefix +
//          indicator name + display suffix).
//   tbody: <tr class="rgRow|rgAltRow"> with <td> cells = [geoName, geoId, val1, val2, ...].
// We return { columns:[label,...], rows:[{geoName, geoId, values:{label:value}}] }.

const stripTags = s => (s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;/g, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ')
  .trim();

// Extract the rgMasterTable region (from its opening tag to the end of the document
// is fine — we then scope header/body by the first thead/tbody that follow).
function extractMasterTable(html) {
  const start = html.search(/<table[^>]*class="rgMasterTable"/i);
  if (start === -1) return null;
  return html.slice(start);
}

function parseGrid(html) {
  const region = extractMasterTable(html);
  if (!region) return { columns: [], rows: [], found: false };

  // Header: th.rgHeader cells within the first thead.
  const theadMatch = region.match(/<thead[\s\S]*?<\/thead>/i);
  const headHtml = theadMatch ? theadMatch[0] : region;
  const headers = [...headHtml.matchAll(/<th[^>]*class="rgHeader"[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(m => stripTags(m[1]));

  // Body rows: tr.rgRow / tr.rgAltRow within the first tbody.
  const tbodyMatch = region.match(/<tbody[\s\S]*?<\/tbody>/i);
  const bodyHtml = tbodyMatch ? tbodyMatch[0] : region;
  const rowMatches = [...bodyHtml.matchAll(/<tr[^>]*class="rg(?:Row|AltRow)"[\s\S]*?<\/tr>/gi)]
    .map(m => m[0]);

  // The number of leading GEO-IDENTITY columns varies by reporting level: Counties have 2
  // (blank Name + blank ID), but finer levels add more (e.g. tracts = "Full ID" + "County" +
  // "2000/2010 Census Tract ID"). Identity headers are blank, end in "ID", or are a geography
  // name token; indicator/value headers carry a year + indicator text (and never end in "ID").
  const isGeoHeader = h => h === '' ||
    /\bid$/i.test(h) ||
    /^(counties|county|townships?|zip|zip codes?|school corporations?|metropolitan statistical|msa|neighborhoods?|blockgroups?|census tracts?|full)\b/i.test(h);
  let valueStart = 0;
  while (valueStart < headers.length && isGeoHeader(headers[valueStart])) valueStart++;
  if (valueStart < 1) valueStart = Math.min(2, headers.length); // safety fallback

  const rows = [];
  for (const tr of rowMatches) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1]));
    if (cells.length <= valueStart) continue; // need identity cols + >=1 value
    // Within the identity columns: geoId = the full numeric id (5-digit county/ZIP,
    // 11-digit tract, 12-digit blockgroup); geoName = the first identity cell with letters.
    const idCells = cells.slice(0, valueStart);
    let geoId = '';
    for (const c of idCells) if (/^\d{5,}$/.test(c) && c.length > geoId.length) geoId = c;
    if (!geoId) geoId = idCells[idCells.length - 1] || '';
    let geoName = '';
    for (const c of idCells) if (/[A-Za-z]/.test(c)) { geoName = c; break; }
    if (!geoName) geoName = idCells[0] || '';
    const values = {};
    for (let i = valueStart; i < cells.length; i++) {
      const label = headers[i] || `col_${i}`;
      values[label] = cells[i];
    }
    rows.push({ geoName, geoId, values });
  }

  // Indicator column labels = header cells from the first value column on.
  const columns = headers.slice(valueStart).filter(Boolean);
  return { columns, rows, found: rows.length > 0 };
}

module.exports = { parseGrid, stripTags };
