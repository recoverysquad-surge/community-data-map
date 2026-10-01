// SAVI — dataset accessor: the harvested indicator values + availability index that
// power the per-layer Reporting Level / Display / Year selectors.
//
// The dataset (data/savi_dataset.json) is built by scraper/build_savi_dataset.js from the
// harvest. Everything here is data-driven: dropdowns only ever offer combinations that
// actually have data.

export const ANY = '__any__';   // sentinel for the "Any" option in every selector

let DATA = null;                 // the light index (levels, categories, indicators+availability)
let indexById = null;
const valueCache = new Map();    // id -> { level: { display: { year: { geoId: rawValue } } } }
const valuePromises = new Map(); // id -> in-flight fetch promise (dedupes concurrent loads)

export async function loadDataset() {
  if (DATA) return DATA;
  DATA = await fetch('data/savi_index.json').then(r => r.json());
  indexById = new Map(DATA.indicators.map(i => [i.id, i]));
  return DATA;
}

// Lazily fetch + cache the value shard for one indicator.
export async function ensureValues(id) {
  if (valueCache.has(id)) return valueCache.get(id);
  if (valuePromises.has(id)) return valuePromises.get(id);
  const p = fetch(`data/values/${id}.json`)
    .then(r => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then(v => { valueCache.set(id, v); valuePromises.delete(id); return v; });
  valuePromises.set(id, p);
  return p;
}

export function getCategories() {
  return DATA ? DATA.categories.slice() : [];
}

export function getIndicators(catId) {
  if (!DATA) return [];
  if (!catId) return DATA.indicators.slice();
  const cat = DATA.categories.find(c => c.id === catId);
  const label = cat ? cat.label : catId;
  return DATA.indicators.filter(i => i.category === label);
}

export function searchIndicators(q) {
  if (!DATA) return [];
  const s = String(q || '').trim().toLowerCase();
  if (!s) return DATA.indicators.slice();
  return DATA.indicators.filter(i =>
    i.label.toLowerCase().includes(s) || (i.path || '').toLowerCase().includes(s));
}

export function getIndicator(id) {
  return indexById ? indexById.get(id) : null;
}

// ---- availability (drives the cascading dropdowns) ----
export function availableLevels(id) {
  const ind = getIndicator(id);
  return ind ? Object.keys(ind.availability) : [];
}

export function availableDisplays(id, level) {
  const ind = getIndicator(id);
  if (!ind) return [];
  if (level && level !== ANY) return Object.keys(ind.availability[level] || {});
  // ANY level: union of displays across all levels.
  const set = new Set();
  Object.values(ind.availability).forEach(byDisp => Object.keys(byDisp).forEach(d => set.add(d)));
  return [...set];
}

export function availableYears(id, level, display) {
  const ind = getIndicator(id);
  if (!ind) return [];
  const levels = (level && level !== ANY) ? [level] : Object.keys(ind.availability);
  const set = new Set();
  levels.forEach(lv => {
    const byDisp = ind.availability[lv] || {};
    const displays = (display && display !== ANY) ? [display] : Object.keys(byDisp);
    displays.forEach(d => (byDisp[d] || []).forEach(y => set.add(y)));
  });
  return [...set].sort();
}

// Resolve a selection (which may contain ANY) to a concrete { level, display, year }
// that has data, or null if none. Preference: first level, first display, LATEST year.
export function resolveSelection(id, sel) {
  const ind = getIndicator(id);
  if (!ind) return null;
  sel = sel || {};

  const levels = (sel.level && sel.level !== ANY) ? [sel.level] : Object.keys(ind.availability);
  for (const level of levels) {
    const byDisp = ind.availability[level];
    if (!byDisp) continue;
    const displays = (sel.display && sel.display !== ANY) ? [sel.display] : Object.keys(byDisp);
    for (const display of displays) {
      const years = byDisp[display];
      if (!years || !years.length) continue;
      let year;
      if (sel.year && sel.year !== ANY && years.includes(sel.year)) year = sel.year;
      else year = years[years.length - 1];   // latest available
      if (year) return { level, display, year };
    }
  }
  return null;
}

// Value map { geoId: rawValue } for a concrete combination (loads the shard on demand).
export async function getValueMap(id, level, display, year) {
  const V = await ensureValues(id);
  if (!V || !V[level] || !V[level][display]) return {};
  return V[level][display][year] || {};
}

export function geometryFor(level) {
  return (DATA && DATA.levels[level]) || null;
}

// All reporting-level names present in the dataset.
export function getLevels() {
  return DATA ? Object.keys(DATA.levels) : [];
}
