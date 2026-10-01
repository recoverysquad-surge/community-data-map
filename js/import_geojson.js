// SAVI — import map data from GeoJSON or KML, by file upload OR a URL.
// GeoJSON is parsed natively (zero dependencies). Plain .kml is converted to
// GeoJSON via @tmcw/togeojson, which is loaded lazily from a CDN ONLY when a KML
// is actually imported — so the common GeoJSON path stays dependency-free and
// works offline. Shapefiles and KMZ (zipped KML) aren't supported; the dialog
// points users to mapshaper.org, which converts either to GeoJSON for free.

const TOGEOJSON_CDN = 'https://esm.sh/@tmcw/togeojson@5.8.1';

let togeojsonMod = null;
async function loadToGeoJson() {
  if (!togeojsonMod) togeojsonMod = await import(/* @vite-ignore */ TOGEOJSON_CDN);
  return togeojsonMod;
}

// Normalize any GeoJSON object into a flat array of Features. Accepts a
// FeatureCollection, a single Feature, a bare geometry, or a GeometryCollection.
function toFeatures(gj) {
  if (!gj || typeof gj !== 'object') return [];
  if (gj.type === 'FeatureCollection') return (gj.features || []).filter(Boolean);
  if (gj.type === 'Feature') return gj.geometry ? [gj] : [];
  if (gj.type === 'GeometryCollection') {
    return (gj.geometries || []).map(g => ({ type: 'Feature', geometry: g, properties: {} }));
  }
  // Bare geometry (Point, Polygon, ...).
  if (gj.type && gj.coordinates) return [{ type: 'Feature', geometry: gj, properties: {} }];
  return [];
}

function looksLikeKml(name, text) {
  if (/\.kml$/i.test(name || '')) return true;
  return /<kml[\s>]/i.test(String(text).slice(0, 2000));
}

function looksLikeUnsupported(name) {
  return /\.(kmz|shp|zip|dbf|shx|prj)$/i.test(name || '');
}

// Parse raw file/URL text (named for extension sniffing) into a Feature array.
async function parseContent(name, text) {
  if (looksLikeKml(name, text)) {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    if (dom.querySelector('parsererror')) throw new Error('That KML could not be parsed.');
    const { kml } = await loadToGeoJson();
    return toFeatures(kml(dom));
  }
  let gj;
  try { gj = JSON.parse(text); }
  catch { throw new Error('That file is not valid GeoJSON (could not parse JSON).'); }
  const feats = toFeatures(gj);
  if (!feats.length) throw new Error('No features found. Expected GeoJSON or KML.');
  return feats;
}

// deps = { createGeojsonLayer(label, features) -> Promise<{ features, layers }> }
export function openImportGeojson(deps = {}) {
  const old = document.getElementById('import-geo-overlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.className = 'cmp-overlay open';
  overlay.id = 'import-geo-overlay';
  const modal = document.createElement('div');
  modal.className = 'cmp-modal import-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Import GeoJSON or KML');

  modal.innerHTML = `
    <h2 class="import-title">Import GeoJSON or KML</h2>
    <p class="import-lead">Add your own map data as a layer. Upload a
      <strong>GeoJSON</strong> (<code>.geojson</code>/<code>.json</code>) or
      <strong>KML</strong> file, or paste a link to one. Points, lines and areas
      are all supported.</p>
    <label class="import-field">Layer name
      <input type="text" class="import-name" placeholder="Imported data" />
    </label>
    <label class="import-field">File
      <input type="file" class="import-file" accept=".geojson,.json,.kml,application/geo+json,application/json,application/vnd.google-earth.kml+xml" />
    </label>
    <div class="import-or">or</div>
    <label class="import-field">URL
      <input type="url" class="import-url" placeholder="https://example.com/data.geojson" />
    </label>
    <p class="import-note">Have a <strong>shapefile</strong> or <strong>KMZ</strong>?
      Convert it to GeoJSON for free at
      <a href="https://mapshaper.org" target="_blank" rel="noopener">mapshaper.org</a>,
      then import the result here.</p>
    <div class="import-status" role="status" aria-live="polite"></div>
    <div class="import-actions">
      <button type="button" class="tb-btn tb-primary import-go" disabled>Import</button>
      <button type="button" class="tb-btn import-cancel">Cancel</button>
    </div>`;

  const nameInput = modal.querySelector('.import-name');
  const fileInput = modal.querySelector('.import-file');
  const urlInput = modal.querySelector('.import-url');
  const statusEl = modal.querySelector('.import-status');
  const goBtn = modal.querySelector('.import-go');
  const cancelBtn = modal.querySelector('.import-cancel');

  const close = () => overlay.remove();
  const setStatus = (msg, cls) => { statusEl.textContent = msg; statusEl.className = 'import-status' + (cls ? ' ' + cls : ''); };
  const syncGo = () => { goBtn.disabled = !(fileInput.files.length || urlInput.value.trim()); };

  fileInput.addEventListener('change', () => {
    syncGo();
    if (fileInput.files.length) {
      const fn = fileInput.files[0].name;
      if (looksLikeUnsupported(fn)) {
        setStatus('That file type isn\u2019t supported. Convert it to GeoJSON at mapshaper.org first.', 'error');
      } else {
        setStatus('');
        if (!nameInput.value.trim()) nameInput.value = fn.replace(/\.(geojson|json|kml)$/i, '');
      }
    }
  });
  urlInput.addEventListener('input', syncGo);

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true; cancelBtn.disabled = true;
    try {
      let name = '', text = '';
      if (fileInput.files.length) {
        const file = fileInput.files[0];
        if (looksLikeUnsupported(file.name)) throw new Error('Unsupported file type. Convert it to GeoJSON at mapshaper.org first.');
        name = file.name;
        setStatus('Reading file\u2026');
        text = await file.text();
      } else {
        const url = urlInput.value.trim();
        name = url.split('?')[0];
        setStatus('Fetching\u2026');
        let res;
        try { res = await fetch(url); }
        catch { throw new Error('Could not fetch that URL (network error or blocked by CORS).'); }
        if (!res.ok) throw new Error(`Fetch failed (HTTP ${res.status}).`);
        text = await res.text();
      }

      setStatus('Parsing\u2026');
      const features = await parseContent(name, text);
      if (!features.length) throw new Error('No map features found in that data.');

      const label = nameInput.value.trim() || 'Imported data';
      const r = await deps.createGeojsonLayer(label, features);
      const count = (r && r.features) || features.length;
      const layers = (r && r.layers) || 1;
      setStatus(`Imported ${count} feature${count === 1 ? '' : 's'}`
        + (layers > 1 ? ` across ${layers} layers.` : '.'), 'ok');
      setTimeout(close, 1300);
    } catch (err) {
      setStatus('Import failed: ' + (err && err.message ? err.message : 'unknown error'), 'error');
      goBtn.disabled = false; cancelBtn.disabled = false;
    }
  });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
