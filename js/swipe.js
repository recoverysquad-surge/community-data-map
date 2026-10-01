// SAVI — swipe compare: a second, synced MapLibre map clipped by a draggable
// vertical divider. Left of the divider shows the main map (at a chosen LEFT year);
// right of it shows a clone of the active layers at a chosen RIGHT (compare) year.

let S = null;   // the active swipe session (only one at a time)

export function isSwipeOpen() { return !!S; }

// opts = { mainMap, styleSpec, years:[...], initialYear (right), initialLeftYear,
//          populate(compareMap, year), onLeftYear(year), onClose }
// populate rebuilds the RIGHT clone for a year; onLeftYear retunes the LEFT main map.
export function openSwipe({ mainMap, styleSpec, years, initialYear, initialLeftYear, populate, onLeftYear, onClose }) {
  if (S) closeSwipe();
  const mapEl = document.getElementById('map');

  // Clone map overlays the main map exactly; pointer-events pass through to the
  // main map beneath so the user still pans/zooms/clicks a single map.
  const container = document.createElement('div');
  container.id = 'map-compare';

  // Draggable vertical divider + round grip.
  const divider = document.createElement('div');
  divider.className = 'swipe-divider';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', 'Drag to move the compare divider');
  divider.tabIndex = 0;
  const handle = document.createElement('div');
  handle.className = 'swipe-handle';
  handle.innerHTML = '<span>\u25c0</span><span>\u25b6</span>';
  divider.appendChild(handle);

  // Corner ribbons name each side.
  const tagL = document.createElement('div');
  tagL.className = 'swipe-tag swipe-tag-l';
  const tagR = document.createElement('div');
  tagR.className = 'swipe-tag swipe-tag-r';

  const leftYear = initialLeftYear != null ? initialLeftYear : years[years.length - 1];

  // Build a labelled year <select> for one side.
  const mkYearSelect = (labelText, selected) => {
    const lab = document.createElement('label');
    lab.className = 'swipe-panel-year';
    lab.appendChild(document.createTextNode(labelText));
    const sel = document.createElement('select');
    sel.className = 'swipe-year';
    years.forEach(y => {
      const o = document.createElement('option');
      o.value = y; o.textContent = y;
      if (String(y) === String(selected)) o.selected = true;
      sel.appendChild(o);
    });
    lab.appendChild(sel);
    return { lab, sel };
  };

  // Control panel: left + right year selectors + exit.
  const panel = document.createElement('div');
  panel.className = 'swipe-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Swipe compare controls');
  const title = document.createElement('span');
  title.className = 'swipe-panel-title';
  title.textContent = 'Swipe compare';
  const left = mkYearSelect('Left', leftYear);
  const right = mkYearSelect('Right', initialYear);
  const leftSel = left.sel;
  const yearSel = right.sel;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'swipe-close';
  close.textContent = '\u00d7';
  close.title = 'Exit swipe compare';
  panel.append(title, left.lab, right.lab, close);

  mapEl.append(container, divider, tagL, tagR, panel);

  const compareMap = new maplibregl.Map({
    container,
    style: styleSpec,
    center: mainMap.getCenter(),
    zoom: mainMap.getZoom(),
    bearing: mainMap.getBearing(),
    pitch: mainMap.getPitch(),
    interactive: false,
    attributionControl: false,
    preserveDrawingBuffer: true
  });

  // Lock the clone to the main map's view on every move.
  const sync = () => compareMap.jumpTo({
    center: mainMap.getCenter(), zoom: mainMap.getZoom(),
    bearing: mainMap.getBearing(), pitch: mainMap.getPitch()
  });
  mainMap.on('move', sync);

  S = { container, divider, tagL, tagR, panel, compareMap, mainMap, sync, x: 0 };

  const setTagL = (y) => { tagL.textContent = 'Left: ' + y; };
  const setTagR = (y) => { tagR.textContent = 'Right: ' + y; };
  setTagL(leftYear);
  setTagR(initialYear);

  // Reveal the clone map only to the RIGHT of the divider.
  const setSplit = (x) => {
    const w = mapEl.clientWidth;
    x = Math.max(24, Math.min(w - 24, x));
    S.x = x;
    divider.style.left = x + 'px';
    const clip = `inset(0 0 0 ${x}px)`;
    container.style.clipPath = clip;
    container.style.webkitClipPath = clip;
  };
  setSplit(mapEl.clientWidth / 2);
  S.setSplit = setSplit;

  // Drag the divider left/right.
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const left = mapEl.getBoundingClientRect().left;
    const move = (ev) => setSplit(ev.clientX - left);
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      divider.classList.remove('dragging');
    };
    divider.classList.add('dragging');
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });

  // Keyboard: arrow keys nudge the divider once it has focus.
  divider.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 12;
    if (e.key === 'ArrowLeft') { setSplit(S.x - step); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setSplit(S.x + step); e.preventDefault(); }
  });

  const onResize = () => setSplit(S.x);
  window.addEventListener('resize', onResize);
  S.onResize = onResize;

  yearSel.addEventListener('change', async () => {
    setTagR(yearSel.value);
    await populate(compareMap, yearSel.value);
  });

  // Left year retunes the main map beneath (owned by app.js via onLeftYear).
  leftSel.addEventListener('change', () => {
    setTagL(leftSel.value);
    if (onLeftYear) onLeftYear(leftSel.value);
  });

  close.addEventListener('click', () => closeSwipe());
  S.onCloseCb = onClose;

  // Build the compare layers once the clone map's style is ready.
  compareMap.on('load', async () => { await populate(compareMap, initialYear); });

  return S;
}

export function closeSwipe() {
  if (!S) return;
  S.mainMap.off('move', S.sync);
  window.removeEventListener('resize', S.onResize);
  try { S.compareMap.remove(); } catch { /* already gone */ }
  [S.container, S.divider, S.tagL, S.tagR, S.panel].forEach(el => el && el.remove());
  const cb = S.onCloseCb;
  S = null;
  if (cb) cb();
}
