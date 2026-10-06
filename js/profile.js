// SAVI — Community Profile view: pick ONE geography and see every indicator that has
// data for it, grouped by category (each shown at its latest display/year). Mirrors the
// classic site's CommunityProfiles.aspx fact sheet, but built from the harvested shards.

import { loadDataset, getCategories, getIndicators, getLevels, getIndicator,
  availableDisplays, resolveSelection, getValueMap } from './dataset.js?v=97';

// ---- module state (one live profile at a time) ----
const P = {
  deps: null,     // { getGeo }
  level: null,
  geos: [],       // [{ id, name }] for the current level
  geoId: null,    // selected geography
  query: '',      // indicator filter text
  facts: null,    // [{ category, items:[{label, path, value, display, year}] }]
  activeCat: null, // category label currently shown in the main pane
  sub: []         // sub-category drill-down path beneath the active category
};

// An item's breadcrumb segments BELOW its category (category prefix stripped),
// e.g. category "Demographics", path "Demographics / Age / Seniors" -> ["Age","Seniors"].
function subSegs(it, category) {
  const segs = String(it.path || '').split('/').map(s => s.trim()).filter(Boolean);
  if (segs.length && segs[0] === category) segs.shift();
  return segs;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Load the geography list (rows) for a reporting level via the app's cached getGeo.
async function loadGeos(level) {
  const gj = await P.deps.getGeo(level);
  const feats = (gj && gj.features) || [];
  P.geos = feats
    .map(f => ({ id: f.properties.id, name: f.properties.name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Build the fact sheet for the selected geography: for every indicator available at the
// current level, resolve its latest display/year and read this geo's value.
async function buildFacts() {
  const level = P.level, geoId = P.geoId;
  const cats = getCategories();
  const out = [];
  for (const cat of cats) {
    const inds = getIndicators(cat.id).filter(i => availableDisplays(i.id, level).length > 0);
    if (!inds.length) continue;
    // Resolve + fetch each indicator's latest value for this geo (in parallel).
    const items = await Promise.all(inds.map(async (ind) => {
      const r = resolveSelection(ind.id, { level, display: '__any__', year: '__any__' });
      if (!r) return null;
      const vm = await getValueMap(ind.id, r.level, r.display, r.year);
      const value = vm[geoId];
      if (value == null || value === '') return null;   // skip blanks for this geo
      return { label: ind.label, path: ind.path || '', value, display: r.display, year: r.year };
    }));
    const kept = items.filter(Boolean).sort((a, b) => a.label.localeCompare(b.label));
    if (kept.length) out.push({ category: cat.label, items: kept });
  }
  P.facts = out;
}

// Render the right pane for the active category: a breadcrumb trail, folder
// buttons for the next sub-category level, and fact cards for items that
// terminate at the current drill-down depth (P.sub).
function renderMain(main, active, container) {
  const depth = P.sub.length;

  // Breadcrumb for navigating back up — only shown once drilled in, since at the
  // top level the single root crumb would just duplicate the category title below.
  if (depth > 0) {
    const crumbs = el('nav', 'prof-crumbs');
    const root = el('button', 'prof-crumb', active.category);
    root.type = 'button';
    root.addEventListener('click', () => { P.sub = []; renderFacts(container); });
    crumbs.appendChild(root);
    P.sub.forEach((seg, i) => {
      crumbs.appendChild(el('span', 'prof-crumb-sep', '\u203a'));
      const last = i === depth - 1;
      const c = el('button', 'prof-crumb' + (last ? ' current' : ''), seg);
      c.type = 'button';
      c.addEventListener('click', () => { P.sub = P.sub.slice(0, i + 1); renderFacts(container); });
      crumbs.appendChild(c);
    });
    main.appendChild(crumbs);
  }

  // Partition the category's items by their path relative to the current depth.
  const folders = new Map();   // next segment -> count of items beneath it
  const leaves = [];           // items ending exactly at this level
  active.items.forEach(it => {
    const segs = subSegs(it, active.category);
    // Must sit under the current drill path.
    for (let i = 0; i < depth; i++) { if (segs[i] !== P.sub[i]) return; }
    const rest = segs.slice(depth);
    if (rest.length === 0) leaves.push(it);
    else folders.set(rest[0], (folders.get(rest[0]) || 0) + 1);
  });

  const title = depth ? P.sub[depth - 1] : active.category;
  main.appendChild(el('h3', 'prof-cat-title', `${title} (${active.items.length})`));

  // Folder buttons drill one level deeper.
  if (folders.size) {
    const folderWrap = el('div', 'prof-folders');
    Array.from(folders.keys()).sort((a, b) => a.localeCompare(b)).forEach(name => {
      const btn = el('button', 'prof-folder');
      btn.type = 'button';
      btn.appendChild(el('span', 'prof-folder-name', name));
      btn.appendChild(el('span', 'prof-folder-count', String(folders.get(name))));
      btn.addEventListener('click', () => { P.sub = [...P.sub, name]; renderFacts(container); });
      folderWrap.appendChild(btn);
    });
    main.appendChild(folderWrap);
  }

  // Fact cards for items terminating here.
  if (leaves.length) {
    const grid = el('div', 'prof-grid');
    leaves.forEach(it => {
      const card = el('div', 'prof-fact');
      card.appendChild(el('div', 'prof-fact-value', it.value));
      card.appendChild(el('div', 'prof-fact-label', it.label));
      card.appendChild(el('div', 'prof-fact-meta', `${it.display} \u00b7 ${it.year}`));
      grid.appendChild(card);
    });
    main.appendChild(grid);
  }
}

function renderFacts(container) {
  container.innerHTML = '';
  if (!P.geoId) {
    container.appendChild(el('p', 'prof-empty', 'Select a geography to view its profile.'));
    return;
  }
  if (!P.facts || !P.facts.length) {
    container.appendChild(el('p', 'prof-empty', 'No indicator data found for this geography.'));
    return;
  }
  const q = P.query.trim().toLowerCase();
  // Filter each category's items by the search text; keep only categories with matches.
  const groups = P.facts
    .map(g => ({
      category: g.category,
      items: q
        ? g.items.filter(it => it.label.toLowerCase().includes(q) || (it.path || '').toLowerCase().includes(q))
        : g.items
    }))
    .filter(g => g.items.length);

  if (!groups.length) {
    container.appendChild(el('p', 'prof-empty', q ? 'No indicators match your search.' : 'No indicator data found for this geography.'));
    return;
  }

  // Keep the active category if it still has matches, else fall back to the first.
  let active = groups.find(g => g.category === P.activeCat);
  if (!active) { active = groups[0]; P.activeCat = active.category; }

  const split = el('div', 'prof-split');

  // Left: category navigation with per-category counts.
  const nav = el('nav', 'prof-sidebar');
  nav.setAttribute('aria-label', 'Profile categories');
  groups.forEach(g => {
    const btn = el('button', 'prof-cat-btn' + (g.category === active.category ? ' active' : ''));
    btn.type = 'button';
    btn.appendChild(el('span', 'prof-cat-name', g.category));
    btn.appendChild(el('span', 'prof-cat-count', String(g.items.length)));
    btn.addEventListener('click', () => { P.activeCat = g.category; P.sub = []; renderFacts(container); });
    nav.appendChild(btn);
  });
  split.appendChild(nav);

  // Right: breadcrumb drill-down into the active category's sub-categories.
  const main = el('div', 'prof-main');
  renderMain(main, active, container);
  split.appendChild(main);

  container.appendChild(split);
}

// Reload facts for the current geo, then re-render (with a loading state).
async function refresh(container) {
  if (!P.geoId) { renderFacts(container); return; }
  container.innerHTML = '';
  container.appendChild(el('p', 'prof-loading', 'Loading profile\u2026'));
  await buildFacts();
  renderFacts(container);
}

// ---- main entry: open the Community Profile modal ----
// preselect (optional) = { level, geoId } jumps straight to one geography's sheet.
export async function openProfileModal(deps, preselect) {
  P.deps = deps;
  await loadDataset();
  const levels = getLevels();
  if (preselect && preselect.level) P.level = preselect.level;
  if (!P.level) P.level = levels[0];

  let overlay = document.getElementById('prof-overlay');
  if (overlay) {
    overlay.classList.add('open');
    // A preselect on an already-open modal re-targets + re-renders it.
    if (preselect && preselect.geoId != null) {
      const container = overlay.querySelector('.prof-wrap');
      P.facts = null;
      await loadGeos(P.level);
      P.geoId = String(preselect.geoId);
      if (overlay._fillGeoOptions) overlay._fillGeoOptions();
      if (container) await refresh(container);
    }
    return;
  }

  overlay = el('div', 'cmp-overlay prof-overlay open');
  overlay.id = 'prof-overlay';
  const modal = el('div', 'cmp-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Community Profile');

  const bar = el('div', 'cmp-bar');
  bar.appendChild(el('span', 'cmp-title', 'Community Profile'));

  // Reporting level.
  const levelGroup = el('label', 'cmp-level');
  levelGroup.appendChild(el('span', null, 'Level'));
  const levelSel = el('select', 'cmp-mini');
  levels.forEach(l => {
    const o = el('option', null, l); o.value = l; if (l === P.level) o.selected = true;
    levelSel.appendChild(o);
  });
  levelSel.disabled = levels.length <= 1;
  levelGroup.appendChild(levelSel);
  bar.appendChild(levelGroup);

  // Geography.
  const geoGroup = el('label', 'cmp-level');
  geoGroup.appendChild(el('span', null, 'Geography'));
  const geoSel = el('select', 'cmp-mini');
  geoGroup.appendChild(geoSel);
  bar.appendChild(geoGroup);

  // Indicator filter.
  const filter = el('input', 'prof-filter');
  filter.type = 'search';
  filter.placeholder = 'Filter indicators\u2026';
  bar.appendChild(filter);

  const spacer = el('div', 'cmp-spacer');
  bar.appendChild(spacer);

  const close = el('button', 'cmp-close', '\u00d7');
  close.title = 'Close';
  bar.appendChild(close);

  const container = el('div', 'cmp-table-wrap prof-wrap');

  modal.appendChild(bar);
  modal.appendChild(container);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const fillGeoOptions = () => {
    geoSel.innerHTML = '';
    const ph = el('option', null, `Select a ${P.level.toLowerCase()}\u2026`);
    ph.value = '';
    geoSel.appendChild(ph);
    P.geos.forEach(g => {
      const o = el('option', null, `${g.name} (${g.id})`); o.value = g.id;
      if (g.id === P.geoId) o.selected = true;
      geoSel.appendChild(o);
    });
  };

  overlay._fillGeoOptions = fillGeoOptions;

  await loadGeos(P.level);
  // Honor an initial geography preselect (e.g. "View full profile" from a popup).
  if (preselect && preselect.geoId != null) { P.geoId = String(preselect.geoId); P.facts = null; }
  fillGeoOptions();
  if (P.geoId) { await refresh(container); } else { renderFacts(container); }

  levelSel.addEventListener('change', async () => {
    P.level = levelSel.value;
    P.geoId = null;
    await loadGeos(P.level);
    fillGeoOptions();
    P.facts = null;
    renderFacts(container);
  });

  geoSel.addEventListener('change', async () => {
    P.geoId = geoSel.value || null;
    await refresh(container);
  });

  filter.addEventListener('input', () => { P.query = filter.value; renderFacts(container); });

  const dismiss = () => overlay.classList.remove('open');
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(); });
}
