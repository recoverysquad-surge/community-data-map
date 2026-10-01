// SAVI — UI builders: flat draggable layer list, legend, basemap switcher.

import { accentColor, RAMPS } from './layers.js?v=78';
import { ANY, availableLevels, availableDisplays, availableYears,
  searchIndicators } from './dataset.js?v=78';
import { makeDraggable } from './panels.js?v=78';

// Normalize any hex color to #rrggbb (input[type=color] requires the 6-digit form).
function toHex(c) {
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map(x => x + x).join('');
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  return '#888888';
}

// CSS background-image for a fill pattern kind, tinted with `color`.
// Mirrors the on-map canvas patterns and the .pat-swatch picker styles.
function patternCss(kind, color) {
  const c = color || '#555';
  if (kind === 'diagonal') return `repeating-linear-gradient(45deg, ${c} 0 1.5px, transparent 1.5px 5px)`;
  if (kind === 'crosshatch') return `repeating-linear-gradient(45deg, ${c} 0 1.5px, transparent 1.5px 5px), repeating-linear-gradient(-45deg, ${c} 0 1.5px, transparent 1.5px 5px)`;
  if (kind === 'dots') return `radial-gradient(${c} 25%, transparent 27%)`;
  return '';
}

// Draggable "Rename layer" dialog. Clearly names the layer being edited so the
// user always knows which layer the new name applies to. onCommit(newName) fires
// on Save/Enter with the trimmed value; Cancel/Escape/backdrop just dismisses.
function openRenameDialog(layer, onCommit) {
  const existing = document.getElementById('rename-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'rename-overlay';
  overlay.className = 'rename-overlay';

  const dlg = document.createElement('div');
  dlg.className = 'rename-dialog';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', `Rename layer ${layer.label}`);

  const header = document.createElement('div');
  header.className = 'rename-header';
  const htitle = document.createElement('span');
  htitle.className = 'rename-title';
  htitle.textContent = 'Rename Layer';
  const hx = document.createElement('button');
  hx.type = 'button';
  hx.className = 'rename-x';
  hx.textContent = '\u00d7';
  hx.title = 'Cancel';
  header.appendChild(htitle);
  header.appendChild(hx);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'rename-body';

  const whichLbl = document.createElement('div');
  whichLbl.className = 'rename-which';
  whichLbl.textContent = 'Editing:';
  const whichName = document.createElement('div');
  whichName.className = 'rename-which-name';
  whichName.textContent = layer.label;
  whichName.title = layer.label;

  const field = document.createElement('label');
  field.className = 'rename-field';
  field.textContent = 'New name';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = layer.label;
  input.setAttribute('aria-label', `New name for ${layer.label}`);
  field.appendChild(input);

  bodyEl.appendChild(whichLbl);
  bodyEl.appendChild(whichName);
  bodyEl.appendChild(field);

  const footer = document.createElement('div');
  footer.className = 'rename-footer';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'rename-btn rename-cancel';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'rename-btn rename-save';
  save.textContent = 'Save';
  footer.appendChild(cancel);
  footer.appendChild(save);

  dlg.appendChild(header);
  dlg.appendChild(bodyEl);
  dlg.appendChild(footer);
  overlay.appendChild(dlg);
  document.body.appendChild(overlay);

  makeDraggable(dlg, header);

  let done = false;
  const close = () => { if (done) return; done = true; overlay.remove(); document.removeEventListener('keydown', onKey); };
  const commit = () => { const v = input.value.trim(); close(); if (v) onCommit(v); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); commit(); }
  };

  save.addEventListener('click', commit);
  cancel.addEventListener('click', close);
  hx.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  input.focus();
  input.select();
}

// Overlay a polygon layer's fill pattern onto a chip/swatch (over its base color).
function applyPatternOverlay(el, cfg, baseImage) {
  if (!(cfg.geometry === 'polygon' && cfg.pattern && cfg.pattern !== 'none')) return;
  const pat = patternCss(cfg.pattern, cfg.patternColor || '#555');
  if (!pat) return;
  el.style.backgroundImage = baseImage ? `${pat}, ${baseImage}` : pat;
  el.style.backgroundSize = cfg.pattern === 'dots' ? '6px 6px' : 'auto';
  el.style.backgroundRepeat = 'repeat';
}

// Build a small chip element that visually represents a layer's style.
// choropleth -> mini ramp gradient bar; point -> dot; line -> bar; polygon -> square.
// Polygon layers additionally overlay their chosen fill pattern.
function layerChip(cfg) {
  const chip = document.createElement('span');
  chip.className = 'layer-chip';
  let baseImage = '';
  if (cfg.choropleth && cfg.choropleth.stops && cfg.choropleth.stops.length) {
    chip.classList.add('ramp');
    const colors = cfg.choropleth.stops.map(s => s.color);
    baseImage = `linear-gradient(90deg, ${colors.join(', ')})`;
    chip.style.backgroundImage = baseImage;
  } else if (cfg.geometry === 'point') {
    chip.classList.add('dot');
    chip.style.backgroundColor = accentColor(cfg);
  } else if (cfg.geometry === 'line') {
    chip.classList.add('bar');
    chip.style.backgroundColor = accentColor(cfg);
  } else {
    chip.classList.add('square');
    chip.style.backgroundColor = accentColor(cfg);
    chip.style.borderColor = accentColor(cfg);
  }
  applyPatternOverlay(chip, cfg, baseImage);
  return chip;
}

// Build the flat, HTML5-draggable layer list. Order is handlers.order (top = drawn on top).
export function buildLayerPanel(catalog, handlers) {
  const panel = document.getElementById('layer-panel');
  panel.innerHTML = '';

  const catLabel = {};
  catalog.categories.forEach(c => { catLabel[c.id] = c.label; });
  const byId = {};
  catalog.layers.forEach(l => { byId[l.id] = l; });

  handlers.order.forEach(id => {
    const layer = byId[id];
    if (!layer) return;
    panel.appendChild(buildLayerItem(layer, catLabel[layer.category] || layer.category, handlers, panel));
  });

  // Close any open selector popups whose layer no longer exists.
  document.querySelectorAll('.sel-popup').forEach(p => {
    if (!catalog.layers.some(l => l.id === p.dataset.layerId)) p.remove();
  });
}

function currentOrderIds(panel) {
  return Array.from(panel.querySelectorAll('.layer-item')).map(el => el.dataset.layerId);
}

function buildLayerItem(layer, categoryLabel, handlers, panel) {
  const item = document.createElement('div');
  item.className = 'layer-item';
  item.dataset.layerId = layer.id;
  // Drag-to-reorder is enabled only while grabbing the grip (below), so sliders,
  // selects and buttons inside the row work without triggering a reorder drag.
  item.draggable = false;

  const isActive = handlers.activeLayerIds.has(layer.id);

  const row = document.createElement('div');
  row.className = 'layer-item-row';

  const grip = document.createElement('span');
  grip.className = 'drag-grip';
  grip.title = 'Drag to reorder';
  grip.textContent = '⠿';
  grip.addEventListener('mousedown', () => { item.draggable = true; });
  grip.addEventListener('touchstart', () => { item.draggable = true; }, { passive: true });
  item.addEventListener('mouseup', () => { item.draggable = false; });

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = `chk-${layer.id}`;
  cb.checked = isActive;

  const chip = layerChip(layer);

  const label = document.createElement('label');
  label.htmlFor = cb.id;
  label.className = 'layer-item-label';

  const tag = document.createElement('span');
  tag.className = 'cat-tag';
  tag.textContent = categoryLabel;

  const labelText = document.createElement('span');
  labelText.className = 'layer-label-text';
  labelText.textContent = layer.label;
  labelText.title = 'Double-click to rename';

  label.appendChild(tag);
  label.appendChild(labelText);

  // Rename via a small draggable dialog that names the layer being edited.
  const beginRename = () => {
    openRenameDialog(layer, (v) => {
      if (v && v !== layer.label && handlers.onRename) handlers.onRename(layer.id, v);
    });
  };
  labelText.addEventListener('dblclick', (e) => { e.preventDefault(); beginRename(); });

  // Label + (data layers) a compact subtitle showing the current selection.
  const labelWrap = document.createElement('div');
  labelWrap.className = 'layer-label-wrap';
  labelWrap.appendChild(label);

  const isIndicator = layer.kind === 'indicator' && !!layer.indicatorId;

  const ren = document.createElement('button');
  ren.type = 'button';
  ren.className = 'ren-btn';
  ren.title = 'Rename this layer';
  ren.setAttribute('aria-label', `Rename ${layer.label}`);
  ren.textContent = '\u270e';
  ren.addEventListener('click', () => beginRename());

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'opts-btn';
  gear.title = 'Style options';
  gear.setAttribute('aria-label', `Style options for ${layer.label}`);
  gear.textContent = '⚙';
  gear.addEventListener('click', () => openStylePopup(layer, handlers, gear, styleRow));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del-btn';
  del.title = 'Remove this layer';
  del.setAttribute('aria-label', `Remove ${layer.label}`);
  del.textContent = '×';
  del.addEventListener('click', () => handlers.onDelete && handlers.onDelete(layer.id));

  row.appendChild(grip);
  row.appendChild(cb);
  row.appendChild(chip);
  row.appendChild(labelWrap);

  // Data (indicator) layers: compact subtitle + an "adjust variables" button that
  // opens a movable popup with the Reporting Level / Display / Year selectors.
  if (isIndicator) {
    const adj = document.createElement('button');
    adj.type = 'button';
    adj.className = 'adj-btn';
    adj.title = 'Adjust variables (Reporting Level / Display / Year)';
    adj.setAttribute('aria-label', `Adjust variables for ${layer.label}`);
    adj.textContent = '▤';
    adj.addEventListener('click', () => openSelectorPopup(layer, handlers, adj));

    const sub = document.createElement('div');
    sub.className = 'layer-sub';
    const summary = selectionSummary(layer);
    sub.textContent = summary;
    // Full selection in the tooltip so nothing is lost to the ellipsis.
    sub.title = summary + ' \u2014 click to adjust variables';
    sub.addEventListener('click', () => openSelectorPopup(layer, handlers, adj));
    labelWrap.appendChild(sub);

    row.appendChild(adj);
  }

  // Places (pin) layers: a button to bulk-edit the custom data shared by all pins.
  if (layer.kind === 'pins') {
    const bulk = document.createElement('button');
    bulk.type = 'button';
    bulk.className = 'bulk-btn';
    bulk.title = 'Bulk edit data for all places in this layer';
    bulk.setAttribute('aria-label', `Bulk edit data for ${layer.label}`);
    bulk.textContent = '\u2630';
    bulk.addEventListener('click', () => handlers.onBulkEditPins && handlers.onBulkEditPins(layer.id));
    row.appendChild(bulk);
  }

  // Download this layer's data (GeoJSON for all; pins also offer CSV).
  const dl = document.createElement('button');
  dl.type = 'button';
  dl.className = 'dl-btn';
  dl.title = layer.kind === 'pins'
    ? 'Download this layer (GeoJSON; Shift-click for CSV)'
    : 'Download this layer as GeoJSON';
  dl.setAttribute('aria-label', `Download ${layer.label}`);
  dl.textContent = '\u2913';
  dl.addEventListener('click', (e) => {
    const fmt = (layer.kind === 'pins' && e.shiftKey) ? 'csv' : 'geojson';
    handlers.onDownloadLayer && handlers.onDownloadLayer(layer.id, fmt);
  });
  row.appendChild(dl);

  row.appendChild(ren);
  row.appendChild(gear);
  row.appendChild(del);
  item.appendChild(row);

  // Opacity slider
  const opRow = document.createElement('div');
  opRow.className = 'opacity-row';
  const opLabel = document.createElement('label');
  opLabel.textContent = 'Opacity';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.05';
  slider.value = String(layer.opacity != null ? layer.opacity : 1);
  slider.setAttribute('aria-label', `Opacity for ${layer.label}`);
  const opVal = document.createElement('span');
  opVal.className = 'opacity-val';
  opVal.textContent = Math.round(Number(slider.value) * 100) + '%';

  opRow.appendChild(opLabel);
  opRow.appendChild(slider);
  opRow.appendChild(opVal);
  item.appendChild(opRow);

  // ---- Style options (color + ramp + fill pattern), revealed by the gear button ----
  const styleRow = document.createElement('div');
  styleRow.className = 'style-row';

  // Group helper: a label + control pair that wraps as a unit.
  const addCtl = (labelText, controlEl) => {
    const g = document.createElement('div');
    g.className = 'style-ctl';
    const l = document.createElement('label');
    l.textContent = labelText;
    g.appendChild(l);
    g.appendChild(controlEl);
    styleRow.appendChild(g);
  };

  // Color picker — skipped for category-colored point layers (they have many colors).
  if (!(layer.geometry === 'point' && layer.categoryStyle)) {
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = toHex(accentColor(layer));
    colorInput.addEventListener('input', () => handlers.onColor(layer.id, colorInput.value));
    addCtl(layer.choropleth ? 'Outline' : 'Color', colorInput);
  }

  // Preset color ramp (choropleth layers only) — visual gradient swatches.
  if (layer.choropleth) {
    const picker = document.createElement('div');
    picker.className = 'ramp-picker';
    Object.entries(RAMPS).forEach(([key, ramp]) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'ramp-swatch' + ((layer.ramp || '') === key ? ' active' : '');
      sw.title = ramp.label;
      sw.style.background = `linear-gradient(90deg, ${ramp.colors.join(', ')})`;
      sw.addEventListener('click', () => {
        picker.querySelectorAll('.ramp-swatch').forEach(b => b.classList.remove('active'));
        sw.classList.add('active');
        handlers.onRamp(layer.id, key);
        const chipEl = item.querySelector('.layer-chip.ramp');
        if (chipEl) chipEl.style.background = `linear-gradient(90deg, ${ramp.colors.join(', ')})`;
      });
      picker.appendChild(sw);
    });
    addCtl('Ramp', picker);

    // Classification method + class count (only meaningful for data-driven layers
    // that carry their source values — dynamic indicator choropleths).
    if (layer.sourceData && handlers.onClassify) {
      const classify = layer.classify || {};
      const methodSel = document.createElement('select');
      methodSel.className = 'layer-select classify-select';
      [['quantile', 'Quantile'], ['equal', 'Equal interval'], ['jenks', 'Natural breaks']].forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if ((classify.method || 'quantile') === v) o.selected = true;
        methodSel.appendChild(o);
      });
      methodSel.addEventListener('change', () => handlers.onClassify(layer.id, { method: methodSel.value }));
      addCtl('Method', methodSel);

      const classesSel = document.createElement('select');
      classesSel.className = 'layer-select classify-select';
      for (let n = 3; n <= 7; n++) {
        const o = document.createElement('option');
        o.value = String(n); o.textContent = `${n} classes`;
        if ((classify.classes || 5) === n) o.selected = true;
        classesSel.appendChild(o);
      }
      classesSel.addEventListener('change', () => handlers.onClassify(layer.id, { classes: Number(classesSel.value) }));
      addCtl('Classes', classesSel);
    }
  }

  // Fill pattern (polygon layers only) — visual pattern swatches (cross-hatching etc.).
  if (layer.geometry === 'polygon') {
    const picker = document.createElement('div');
    picker.className = 'pattern-picker';
    [['none', 'None'], ['diagonal', 'Diagonal'], ['crosshatch', 'Cross-hatch'], ['dots', 'Dots']].forEach(([v, t]) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'pat-swatch pat-' + v + ((layer.pattern || 'none') === v ? ' active' : '');
      sw.title = t;
      sw.addEventListener('click', () => {
        picker.querySelectorAll('.pat-swatch').forEach(b => b.classList.remove('active'));
        sw.classList.add('active');
        handlers.onPattern(layer.id, v);
        // Reflect the new pattern in this row's chip (cfg.pattern is set synchronously).
        const oldChip = item.querySelector('.layer-item-row .layer-chip');
        if (oldChip) oldChip.replaceWith(layerChip(layer));
      });
      picker.appendChild(sw);
    });
    addCtl('Pattern', picker);

    // Pattern opacity — independent of the layer's fill opacity, so the hatch
    // can stay visible even when the fill is at 0%.
    const patWrap = document.createElement('div');
    patWrap.className = 'pat-opacity-wrap';
    const patSlider = document.createElement('input');
    patSlider.type = 'range';
    patSlider.min = '0';
    patSlider.max = '1';
    patSlider.step = '0.05';
    patSlider.value = String(layer.patternOpacity != null ? layer.patternOpacity : 1);
    const patVal = document.createElement('span');
    patVal.className = 'opacity-val';
    patVal.textContent = Math.round(Number(patSlider.value) * 100) + '%';
    patSlider.addEventListener('input', () => {
      const v = Number(patSlider.value);
      patVal.textContent = Math.round(v * 100) + '%';
      handlers.onPatternOpacity(layer.id, v);
    });
    patWrap.appendChild(patSlider);
    patWrap.appendChild(patVal);
    addCtl('Pattern opacity', patWrap);
  }

  // styleRow lives in a floating popup (opened by the gear button), not inline.

  cb.addEventListener('change', () => handlers.onToggle(layer.id, cb.checked));
  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    opVal.textContent = Math.round(v * 100) + '%';
    handlers.onOpacity(layer.id, v);
  });

  // ---- HTML5 drag-and-drop reordering ----
  item.addEventListener('dragstart', (e) => {
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', layer.id);
  });
  item.addEventListener('dragend', () => {
    item.draggable = false;
    item.classList.remove('dragging');
    panel.querySelectorAll('.layer-item').forEach(el => el.classList.remove('drag-over'));
  });
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const dragging = panel.querySelector('.layer-item.dragging');
    if (!dragging || dragging === item) return;
    const rect = item.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    panel.querySelectorAll('.layer-item').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
    item.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
    if (before) panel.insertBefore(dragging, item);
    else panel.insertBefore(dragging, item.nextSibling);
  });
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    panel.querySelectorAll('.layer-item').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
    handlers.onReorder(currentOrderIds(panel));
  });

  return item;
}

// Build the three cascading data selectors for a dynamic indicator layer.
// Each has an "Any" option; choosing a Reporting Level constrains the Displays,
// and choosing a Display constrains the Years — all from what data actually exists.
function buildSelectors(layer, handlers, onChanged) {
  layer.sel = layer.sel || { level: ANY, display: ANY, year: ANY };
  const wrap = document.createElement('div');
  wrap.className = 'layer-selectors';

  // Apply the selection (async) then refresh the row subtitle with the result.
  const commit = () => {
    Promise.resolve(handlers.onSelect(layer.id, { ...layer.sel })).then(() => {
      if (onChanged) onChanged();
    });
  };

  const levelSel = makeSelect('Reporting Level');
  const displaySel = makeSelect('Display');
  const yearSel = makeSelect('Year');
  wrap.appendChild(levelSel.group);
  wrap.appendChild(displaySel.group);
  wrap.appendChild(yearSel.group);

  const id = layer.indicatorId;
  const repopulate = () => {
    fillOptions(levelSel.el, availableLevels(id), layer.sel.level);
    fillOptions(displaySel.el, availableDisplays(id, layer.sel.level), layer.sel.display);
    fillOptions(yearSel.el, availableYears(id, layer.sel.level, layer.sel.display), layer.sel.year);
  };
  repopulate();

  levelSel.el.addEventListener('change', () => {
    layer.sel.level = levelSel.el.value;
    // Reset now-invalid downstream picks to Any.
    if (!availableDisplays(id, layer.sel.level).includes(layer.sel.display)) layer.sel.display = ANY;
    if (!availableYears(id, layer.sel.level, layer.sel.display).includes(layer.sel.year)) layer.sel.year = ANY;
    repopulate();
    commit();
  });
  displaySel.el.addEventListener('change', () => {
    layer.sel.display = displaySel.el.value;
    if (!availableYears(id, layer.sel.level, layer.sel.display).includes(layer.sel.year)) layer.sel.year = ANY;
    fillOptions(yearSel.el, availableYears(id, layer.sel.level, layer.sel.display), layer.sel.year);
    commit();
  });
  yearSel.el.addEventListener('change', () => {
    layer.sel.year = yearSel.el.value;
    commit();
  });

  return wrap;
}

// Compact one-line summary of a data layer's current selection — the concrete
// level/display/year actually shown on the map (set by applyIndicatorSelection).
function selectionSummary(layer) {
  const parts = [layer.level, layer.display, layer.year].filter(v => v != null && v !== '');
  return parts.length ? parts.join(' \u00b7 ') : 'Set variables\u2026';
}

// Movable popup holding a data layer's cascading Reporting Level / Display / Year
// selects. Reuses buildSelectors and updates the row subtitle after each change.
let selPopupZ = 300;
function bringPopupToFront(pop) { pop.style.zIndex = String(++selPopupZ); }

function openSelectorPopup(layer, handlers, anchorEl) {
  const domId = `sel-popup-${layer.id}`;
  const existing = document.getElementById(domId);
  if (existing) { bringPopupToFront(existing); return; }

  const pop = document.createElement('div');
  pop.id = domId;
  pop.className = 'sel-popup';
  pop.dataset.layerId = layer.id;

  const header = document.createElement('div');
  header.className = 'sel-popup-header';
  // Show the layer's style chip in the title so it's clear which layer is being edited.
  let titleChip = layerChip(layer);
  titleChip.classList.add('sel-popup-chip');
  const title = document.createElement('span');
  title.className = 'sel-popup-title';
  title.textContent = layer.label;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sel-popup-close';
  close.textContent = '×';
  close.title = 'Close';
  close.addEventListener('click', () => pop.remove());
  header.appendChild(titleChip);
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'sel-popup-body';
  const onChanged = () => {
    const sub = document.querySelector(`.layer-item[data-layer-id="${layer.id}"] .layer-sub`);
    if (sub) {
      const s = selectionSummary(layer);
      sub.textContent = s;
      sub.title = s + ' \u2014 click to adjust variables';
    }
    // Keep the popup chip in sync (a choropleth ramp can change with Display).
    const fresh = layerChip(layer);
    fresh.classList.add('sel-popup-chip');
    titleChip.replaceWith(fresh);
    titleChip = fresh;
  };
  body.appendChild(buildSelectors(layer, handlers, onChanged));

  pop.appendChild(header);
  pop.appendChild(body);
  document.body.appendChild(pop);

  // Initial position: to the right of the anchor button, clamped to the viewport.
  pop.style.position = 'fixed';
  let left = 340, top = 120;
  if (anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    left = r.right + 8;
    top = r.top;
  }
  left = Math.min(left, window.innerWidth - pop.offsetWidth - 8);
  top = Math.min(top, window.innerHeight - pop.offsetHeight - 8);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';

  bringPopupToFront(pop);
  pop.addEventListener('pointerdown', () => bringPopupToFront(pop));
  makeDraggable(pop, header);
}

// Floating, draggable Style-options popup (color / ramp / pattern) opened by the
// gear button — consistent with the "adjust variables" (sel) popup. The styleRow
// element is built once per layer row and re-parented into the popup on open.
function openStylePopup(layer, handlers, anchorEl, styleRow) {
  const domId = `style-popup-${layer.id}`;
  const existing = document.getElementById(domId);
  if (existing) { bringPopupToFront(existing); return; }

  const pop = document.createElement('div');
  pop.id = domId;
  pop.className = 'sel-popup style-popup';
  pop.dataset.layerId = layer.id;

  const header = document.createElement('div');
  header.className = 'sel-popup-header';
  const titleChip = layerChip(layer);
  titleChip.classList.add('sel-popup-chip');
  const title = document.createElement('span');
  title.className = 'sel-popup-title';
  title.textContent = layer.label;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sel-popup-close';
  close.textContent = '×';
  close.title = 'Close';
  // Detach styleRow before removing the popup so its controls + listeners survive.
  close.addEventListener('click', () => { pop.remove(); });
  header.appendChild(titleChip);
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'sel-popup-body';
  body.appendChild(styleRow);   // re-parent the persistent style controls

  pop.appendChild(header);
  pop.appendChild(body);
  document.body.appendChild(pop);

  // Initial position: to the right of the gear button, clamped to the viewport.
  pop.style.position = 'fixed';
  let left = 340, top = 120;
  if (anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    left = r.right + 8;
    top = r.top;
  }
  left = Math.min(left, window.innerWidth - pop.offsetWidth - 8);
  top = Math.min(top, window.innerHeight - pop.offsetHeight - 8);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';

  bringPopupToFront(pop);
  pop.addEventListener('pointerdown', () => bringPopupToFront(pop));
  makeDraggable(pop, header);
}

function makeSelect(labelText) {
  const group = document.createElement('div');
  group.className = 'sel-group';
  const l = document.createElement('label');
  l.textContent = labelText;
  const el = document.createElement('select');
  el.className = 'layer-select';
  group.appendChild(l);
  group.appendChild(el);
  return { group, el };
}

// Fill a <select> with an "Any" option + the given values; select `current`.
function fillOptions(sel, values, current) {
  sel.innerHTML = '';
  const opt = (val, text) => {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = text;
    if (val === current) o.selected = true;
    sel.appendChild(o);
  };
  opt(ANY, 'Any');
  values.forEach(v => opt(v, v));
  // If current isn't among options, fall back to Any.
  if (current !== ANY && !values.includes(current)) sel.value = ANY;
}

// ---- Catalog modal: browse categories -> indicators, add to the map ----
export function openCatalogModal(handlers) {
  let overlay = document.getElementById('catalog-overlay');
  // Reusing an open-once overlay: re-render so Add/Remove states are current.
  if (overlay) { overlay._handlers = handlers; if (overlay._render) overlay._render(); overlay.classList.add('open'); return; }

  overlay = document.createElement('div');
  overlay.id = 'catalog-overlay';
  overlay.className = 'catalog-overlay open';

  const modal = document.createElement('div');
  modal.className = 'catalog-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Add Data');

  const header = document.createElement('div');
  header.className = 'catalog-header';
  const title = document.createElement('span');
  title.textContent = 'Add Data';
  const close = document.createElement('button');
  close.className = 'catalog-close';
  close.textContent = '×';
  close.title = 'Close';
  header.appendChild(title);
  header.appendChild(close);

  const search = document.createElement('input');
  search.className = 'catalog-search';
  search.type = 'search';
  search.placeholder = 'Search indicators\u2026';
  search.setAttribute('aria-label', 'Search indicators');

  const body = document.createElement('div');
  body.className = 'catalog-body';

  const foot = document.createElement('div');
  foot.className = 'catalog-credit';
  foot.innerHTML = 'All indicators sourced from '
    + '<a href="https://classic.savi.org/savi" target="_blank" rel="noopener">SAVI</a>'
    + ' \u2014 Social Assets &amp; Vulnerabilities Indicators, a program of the Polis Center at IU Indianapolis.';

  modal.appendChild(header);
  modal.appendChild(search);
  modal.appendChild(body);
  modal.appendChild(foot);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay._handlers = handlers;
  overlay._nav = [];   // breadcrumb path: [] = top (categories), then subcategory segments

  // Render EITHER flat search results (when the search box has text) OR the
  // breadcrumb drill-down for the current folder (overlay._nav).
  const render = () => {
    body.innerHTML = '';
    const h = overlay._handlers;
    const q = search.value.trim();
    if (q) { renderSearch(body, q, h); return; }
    renderBrowse(body, overlay, render, h);
  };
  overlay._render = render;
  render();

  search.addEventListener('input', render);
  const dismiss = () => overlay.classList.remove('open');
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(); });
}

// Split an indicator's breadcrumb into trimmed segments. The first segment is the
// top-level category; deeper segments are the subcategories we drill through.
function pathSegs(ind) {
  return String(ind.path || ind.category || '')
    .split('/').map(s => s.trim()).filter(Boolean);
}

// Flat search results (search box has text): one list, each row shows its full path.
function renderSearch(body, query, handlers) {
  const matches = searchIndicators(query);
  if (!matches.length) {
    body.innerHTML = '<p class="catalog-empty">No indicators match your search.</p>';
    return;
  }
  const CAP = 400;
  const list = document.createElement('div');
  list.className = 'catalog-cat';
  matches.slice(0, CAP).forEach(ind => list.appendChild(catalogItem(ind, handlers, true)));
  body.appendChild(list);
  if (matches.length > CAP) {
    const more = document.createElement('p');
    more.className = 'catalog-empty';
    more.textContent = `Showing first ${CAP} of ${matches.length} matches \u2014 keep typing to narrow.`;
    body.appendChild(more);
  }
}

// Breadcrumb drill-down for the current folder (overlay._nav). Shows the folders
// (next path segment) that branch off here, then any indicators that live exactly
// at this level. Clicking a folder descends; clicking a crumb jumps back up.
function renderBrowse(body, overlay, render, handlers) {
  const nav = overlay._nav;

  // Breadcrumb bar: Home > seg1 > seg2 ...
  const crumbs = document.createElement('div');
  crumbs.className = 'catalog-crumbs';
  const makeCrumb = (label, depth) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'catalog-crumb';
    b.textContent = label;
    if (depth === nav.length) b.classList.add('current');
    else b.addEventListener('click', () => { overlay._nav = nav.slice(0, depth); render(); });
    return b;
  };
  crumbs.appendChild(makeCrumb('All data', 0));
  nav.forEach((seg, i) => {
    const sep = document.createElement('span');
    sep.className = 'catalog-crumb-sep';
    sep.textContent = '\u203a';
    crumbs.appendChild(sep);
    crumbs.appendChild(makeCrumb(seg, i + 1));
  });
  body.appendChild(crumbs);

  // Partition everything under this folder into child folders (with counts) and
  // indicators that terminate exactly here.
  const folders = new Map();   // folder name -> count of indicators beneath it
  const items = [];
  for (const ind of searchIndicators('')) {
    const segs = pathSegs(ind);
    if (segs.length < nav.length) continue;
    let under = true;
    for (let i = 0; i < nav.length; i++) { if (segs[i] !== nav[i]) { under = false; break; } }
    if (!under) continue;
    if (segs.length === nav.length) items.push(ind);
    else { const name = segs[nav.length]; folders.set(name, (folders.get(name) || 0) + 1); }
  }

  const folderNames = [...folders.keys()].sort((a, b) => a.localeCompare(b));
  if (folderNames.length) {
    const wrap = document.createElement('div');
    wrap.className = 'catalog-folders';
    folderNames.forEach(name => {
      const f = document.createElement('button');
      f.type = 'button';
      f.className = 'catalog-folder';
      const nm = document.createElement('span');
      nm.className = 'catalog-folder-name';
      nm.textContent = name;
      const ct = document.createElement('span');
      ct.className = 'catalog-folder-count';
      ct.textContent = String(folders.get(name));
      f.appendChild(nm);
      f.appendChild(ct);
      f.addEventListener('click', () => { overlay._nav = nav.concat(name); render(); });
      wrap.appendChild(f);
    });
    body.appendChild(wrap);
  }

  if (items.length) {
    if (folderNames.length) {
      const sep = document.createElement('div');
      sep.className = 'catalog-sep';
      body.appendChild(sep);
    }
    const list = document.createElement('div');
    list.className = 'catalog-cat';
    items.sort((a, b) => a.label.localeCompare(b.label));
    items.forEach(ind => list.appendChild(catalogItem(ind, handlers, false)));
    body.appendChild(list);
  }

  if (!folderNames.length && !items.length) {
    body.innerHTML = '<p class="catalog-empty">No indicators here yet.</p>';
  }
}

function catalogItem(ind, handlers, showPath = true) {
  const it = document.createElement('div');
  it.className = 'catalog-item';
  const text = document.createElement('div');
  text.className = 'catalog-item-text';
  const lab = document.createElement('div');
  lab.className = 'catalog-item-label';
  lab.textContent = ind.label;
  text.appendChild(lab);
  if (showPath) {
    const path = document.createElement('div');
    path.className = 'catalog-item-path';
    path.textContent = ind.path || '';
    text.appendChild(path);
  }

  const add = document.createElement('button');
  add.className = 'catalog-add';

  // Reflect whether this indicator is already on the map (added -> Remove toggle).
  const refresh = () => {
    const added = !!(handlers.isAdded && handlers.isAdded(ind.id));
    it.classList.toggle('in-map', added);
    add.textContent = added ? 'Remove' : 'Add';
    add.classList.toggle('remove', added);
    add.disabled = false;
  };

  add.addEventListener('click', async () => {
    const added = !!(handlers.isAdded && handlers.isAdded(ind.id));
    add.disabled = true;
    if (added) {
      if (handlers.onRemove) handlers.onRemove(ind.id);
    } else {
      await handlers.onAdd(ind.id);
    }
    refresh();
  });
  refresh();

  it.appendChild(text);
  it.appendChild(add);
  return it;
}

// Build a chip matching a single legend entry (reuses layer geometry for shape).
// Filled polygon swatches also overlay the layer's chosen fill pattern.
function legendEntrySwatch(entry, cfg) {
  const swatch = document.createElement('span');
  swatch.className = 'legend-swatch';
  if (entry.type === 'circle') swatch.classList.add('circle');
  if (entry.type === 'line') swatch.classList.add('line');
  swatch.style.backgroundColor = entry.color;
  if (entry.outline) swatch.style.borderColor = entry.outline;
  if (cfg && entry.type !== 'circle' && entry.type !== 'line') {
    applyPatternOverlay(swatch, cfg, '');
  }
  return swatch;
}

// Build the legend from active layers, rendered in the given order (top = first).
// opts.onLegendClass(layer, entryIndex): make choropleth classes clickable to
// emphasize matching features. opts.activeHighlight = { layerId, index } marks
// the currently-highlighted class.
export function buildLegend(activeLayersOrdered, opts = {}) {
  const legend = document.getElementById('legend');
  legend.innerHTML = '';

  if (!activeLayersOrdered.length) {
    legend.innerHTML = '<p class="legend-empty">No layers yet \u2014 click '
      + '<strong>+ Data</strong> or <strong>Featured Maps</strong> to get started.</p>';
    legend.appendChild(legendCredit());
    return;
  }

  const hl = opts.activeHighlight;
  const hlIndices = (layer) =>
    (hl && hl.layerId === layer.id && Array.isArray(hl.indices)) ? hl.indices : [];
  activeLayersOrdered.forEach(layer => {
    if (!layer.legend || !layer.legend.length) return;
    const block = document.createElement('div');
    block.className = 'legend-block';

    // Places (pin) layers: a single line = the dot color + the layer name. No
    // separate title or redundant "Saved place" row. Clicking zooms to the pins.
    if (layer.kind === 'pins') {
      const row = document.createElement('div');
      row.className = 'legend-entry legend-pins';
      row.appendChild(legendEntrySwatch(
        { color: (layer.legend[0] && layer.legend[0].color) || '#d4af37', type: 'circle' }, layer));
      const text = document.createElement('span');
      text.textContent = layer.label;
      row.appendChild(text);
      if (opts.onZoomToLayer) {
        row.classList.add('clickable');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.title = 'Zoom to these places';
        row.setAttribute('aria-label', `Zoom to ${layer.label}`);
        const go = () => opts.onZoomToLayer(layer);
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
      }
      block.appendChild(row);
      legend.appendChild(block);
      return;
    }

    // Only choropleth layers support class emphasis (they have value buckets).
    const clickable = !!(opts.onLegendClass && layer.choropleth);
    const highlighted = !!(hl && hl.layerId === layer.id);

    const title = document.createElement('div');
    title.className = 'legend-block-title';
    title.appendChild(layerChip(layer));
    const titleText = document.createElement('span');
    titleText.textContent = layer.label;
    title.appendChild(titleText);

    // Clicking the title (the "main legend icon") clears any class emphasis on
    // this layer, restoring the original coloring for ALL geographies.
    if (clickable && opts.onLegendReset) {
      title.classList.add('resettable');
      if (highlighted) {
        title.classList.add('has-highlight');
        const reset = document.createElement('span');
        reset.className = 'legend-reset';
        reset.textContent = '\u21ba Show all';
        title.appendChild(reset);
      }
      title.setAttribute('role', 'button');
      title.tabIndex = 0;
      title.title = 'Show all geographies (clear highlight)';
      title.setAttribute('aria-label', `Show all geographies for ${layer.label}`);
      const reset = () => opts.onLegendReset(layer);
      title.addEventListener('click', reset);
      title.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reset(); }
      });
    }
    block.appendChild(title);

    // Inline data context: "Counties · Ratio · 2024" (only the parts present).
    const ctx = [layer.level, layer.display, layer.year]
      .filter(v => v != null && v !== '').join(' \u00b7 ');
    if (ctx) {
      const caption = document.createElement('div');
      caption.className = 'legend-caption';
      caption.textContent = ctx;
      block.appendChild(caption);
    }

    layer.legend.forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = 'legend-entry';
      row.appendChild(legendEntrySwatch(entry, layer));
      const text = document.createElement('span');
      text.textContent = entry.label;
      row.appendChild(text);

      if (clickable) {
        const active = hlIndices(layer).includes(index);
        row.classList.add('clickable');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.setAttribute('aria-pressed', String(active));
        if (active) row.classList.add('active');
        row.title = 'Click to show or hide this range on the map \u00b7 click multiple to combine';
        row.setAttribute('aria-label', `Toggle ${layer.label}: ${entry.label}`);
        // Each click toggles this break on/off; combine several by clicking more.
        const fire = () => opts.onLegendClass(layer, index);
        row.addEventListener('click', fire);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
        });
      }
      block.appendChild(row);
    });

    legend.appendChild(block);
  });

  legend.appendChild(legendCredit());
}

// A clear, persistent "data came from SAVI" credit shown at the foot of the legend.
function legendCredit() {
  const credit = document.createElement('div');
  credit.className = 'legend-credit';
  credit.innerHTML =
    'Data source: <a href="https://classic.savi.org/savi" target="_blank" rel="noopener">SAVI</a>'
    + '<br><span class="legend-credit-sub">Social Assets &amp; Vulnerabilities Indicators \u00b7 Polis Center at IU Indianapolis</span>';
  return credit;
}

// Build the basemap switcher buttons.
export function buildBasemapSwitcher(basemaps, current, onSwitch) {
  const container = document.getElementById('basemap-switcher');
  container.innerHTML = '';
  Object.entries(basemaps).forEach(([key, bm]) => {
    const btn = document.createElement('button');
    btn.className = 'basemap-btn' + (key === current ? ' active' : '');
    btn.dataset.basemap = key;
    btn.textContent = bm.label;
    btn.addEventListener('click', () => onSwitch(key));
    container.appendChild(btn);
  });
}
