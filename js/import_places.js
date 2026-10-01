// SAVI — bulk import of places from a CSV. Users upload a CSV whose rows are
// points: a name, a location (either lat/lng columns OR a street address that we
// geocode), and any number of extra columns that become per-point key/value
// ("Custom data") pairs. Geocoding uses Nominatim (key-free) and is rate-limited
// to one request/second per the OSM usage policy, so large address lists import
// slowly; rows that already carry lat/lng skip geocoding entirely.

const IN_VIEWBOX = '-87.8,40.8,-84.6,38.6'; // lon_min,lat_max,lon_max,lat_min (Central Indiana bias)
const GEOCODE_CAP = 100;   // safety cap on address lookups per import
const GEOCODE_GAP = 1100;  // ms between address lookups (OSM policy: <= 1/sec)

// Column header matchers. Anything NOT matched here becomes a custom-data field.
const RE_NAME = /^(name|place|title|label)$/i;
const RE_LAT = /^(lat|latitude|y)$/i;
const RE_LNG = /^(lng|lon|long|longitude|x)$/i;
const RE_ADDR = /^(address|street|addr|address1|address_1)$/i;
const RE_CITY = /^(city|town|municipality)$/i;
const RE_STATE = /^(state|province|region)$/i;
const RE_ZIP = /^(zip|zipcode|postal|postalcode|postal_code|zip_code)$/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, and
// CRLF/LF line endings. Returns an array of string arrays (rows of cells).
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop fully-blank lines.
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

async function geocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=0'
    + `&viewbox=${IN_VIEWBOX}&countrycodes=us&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en-US' } });
  if (!res.ok) throw new Error('geocode failed');
  const arr = await res.json();
  if (!arr.length) return null;
  return { lng: parseFloat(arr[0].lon), lat: parseFloat(arr[0].lat) };
}

// Turn parsed CSV rows into point records. Reports progress via onProgress(msg).
// Returns { points, geocoded, failed, skipped, total }.
async function rowsToPoints(rows, onProgress) {
  const header = rows[0].map(h => String(h).trim());
  const idx = (re) => header.findIndex(h => re.test(h));
  const iName = idx(RE_NAME), iLat = idx(RE_LAT), iLng = idx(RE_LNG);
  const iAddr = idx(RE_ADDR), iCity = idx(RE_CITY), iState = idx(RE_STATE), iZip = idx(RE_ZIP);
  // Columns that are "location/identity" (not custom data).
  const reserved = new Set([iName, iLat, iLng, iAddr, iCity, iState, iZip].filter(n => n >= 0));

  const data = rows.slice(1);
  const points = [];
  let geocoded = 0, failed = 0, skipped = 0, pending = 0;

  for (let r = 0; r < data.length; r++) {
    const cells = data[r];
    const get = (n) => (n >= 0 && n < cells.length ? String(cells[n]).trim() : '');
    const name = get(iName) || `Place ${r + 1}`;
    const meta = header.map((h, c) => ({ type: h, value: get(c) }))
      .filter((m, c) => !reserved.has(c) && (m.value !== ''));

    // 1) Explicit coordinates win.
    const latN = parseFloat(get(iLat));
    const lngN = parseFloat(get(iLng));
    if (Number.isFinite(latN) && Number.isFinite(lngN)) {
      points.push({ name, lat: latN, lng: lngN, meta });
      continue;
    }

    // 2) Otherwise geocode the composed address.
    const addr = [get(iAddr), get(iCity), get(iState), get(iZip)].filter(Boolean).join(', ');
    if (!addr) { failed++; continue; }
    if (pending >= GEOCODE_CAP) { skipped++; continue; }

    if (onProgress) onProgress(`Geocoding ${pending + 1} of ${data.length}\u2026 (${name})`);
    try {
      const hit = await geocode(addr);
      if (hit) { points.push({ name, lat: hit.lat, lng: hit.lng, meta }); geocoded++; }
      else failed++;
    } catch { failed++; }
    pending++;
    if (pending < GEOCODE_CAP) await sleep(GEOCODE_GAP);   // be polite to Nominatim
  }

  return { points, geocoded, failed, skipped, total: data.length };
}

// deps = { createPlacesLayer(label, points) -> Promise<count>, sampleHref }
export function openImportPlaces(deps = {}) {
  const old = document.getElementById('import-overlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.className = 'cmp-overlay open';
  overlay.id = 'import-overlay';
  const modal = document.createElement('div');
  modal.className = 'cmp-modal import-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Import places from a CSV');

  modal.innerHTML = `
    <h2 class="import-title">Import places from a CSV</h2>
    <p class="import-lead">Upload a CSV with one row per place. Include a
      <strong>name</strong> and either <strong>lat</strong> + <strong>lng</strong>
      columns or a street <strong>address</strong> (we\u2019ll look it up). Every other
      column becomes custom data on each point.</p>
    <p class="import-sample">New to this? <a class="import-sample-link"
      href="${deps.sampleHref || 'data/sample_places.csv'}" download>Download a sample CSV</a>
      to try it out.</p>
    <label class="import-field">Layer name
      <input type="text" class="import-name" placeholder="Imported places" />
    </label>
    <label class="import-field">CSV file
      <input type="file" class="import-file" accept=".csv,text/csv" />
    </label>
    <p class="import-note">Address lookups are limited to one per second (OSM policy),
      so address-based files import slowly. Up to ${GEOCODE_CAP} addresses per import.</p>
    <div class="import-status" role="status" aria-live="polite"></div>
    <div class="import-actions">
      <button type="button" class="tb-btn tb-primary import-go" disabled>Import</button>
      <button type="button" class="tb-btn import-cancel">Cancel</button>
    </div>`;

  const nameInput = modal.querySelector('.import-name');
  const fileInput = modal.querySelector('.import-file');
  const statusEl = modal.querySelector('.import-status');
  const goBtn = modal.querySelector('.import-go');
  const cancelBtn = modal.querySelector('.import-cancel');

  const close = () => overlay.remove();
  const setStatus = (msg, cls) => { statusEl.textContent = msg; statusEl.className = 'import-status' + (cls ? ' ' + cls : ''); };

  fileInput.addEventListener('change', () => {
    goBtn.disabled = !fileInput.files.length;
    if (fileInput.files.length && !nameInput.value.trim()) {
      nameInput.value = fileInput.files[0].name.replace(/\.csv$/i, '');
    }
  });

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  goBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    goBtn.disabled = true; cancelBtn.disabled = true;
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (rows.length < 2) { setStatus('That file has no data rows.', 'error'); goBtn.disabled = false; cancelBtn.disabled = false; return; }
      setStatus('Reading rows\u2026');
      const res = await rowsToPoints(rows, (m) => setStatus(m));
      if (!res.points.length) {
        setStatus('No points could be placed. Check the address or lat/lng columns.', 'error');
        goBtn.disabled = false; cancelBtn.disabled = false;
        return;
      }
      const label = nameInput.value.trim() || 'Imported places';
      const count = await deps.createPlacesLayer(label, res.points);
      const bits = [`Imported ${count} place${count === 1 ? '' : 's'}`];
      if (res.geocoded) bits.push(`${res.geocoded} geocoded`);
      if (res.failed) bits.push(`${res.failed} could not be located`);
      if (res.skipped) bits.push(`${res.skipped} skipped (over the ${GEOCODE_CAP} address cap)`);
      setStatus(bits.join(' \u00b7 ') + '.', 'ok');
      setTimeout(close, 1400);
    } catch (err) {
      setStatus('Import failed: ' + (err && err.message ? err.message : 'unknown error'), 'error');
      goBtn.disabled = false; cancelBtn.disabled = false;
    }
  });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
