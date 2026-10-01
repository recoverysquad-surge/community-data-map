// SAVI — floating panel helpers: pointer-drag to move, collapse toggle.

// Make a panel draggable by a handle element. On first grab the panel "undocks"
// (switches to position:fixed) and can then be moved anywhere, clamped to viewport.
export function makeDraggable(panelEl, handleEl, onChange) {
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, moved = false;

  const onMove = (e) => {
    const w = panelEl.offsetWidth;
    const h = panelEl.offsetHeight;
    let left = startLeft + (e.clientX - startX);
    let top = startTop + (e.clientY - startY);
    left = Math.max(0, Math.min(left, window.innerWidth - w));
    top = Math.max(0, Math.min(top, window.innerHeight - h));
    panelEl.style.left = left + 'px';
    panelEl.style.top = top + 'px';
    moved = true;
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    panelEl.classList.remove('dragging');
    document.body.style.userSelect = '';
    if (moved && typeof onChange === 'function') onChange();
  };

  const onDown = (e) => {
    // Ignore drags that start on interactive controls in the header.
    if (e.target.closest('button, input, a')) return;
    const rect = panelEl.getBoundingClientRect();
    // Undock: float the panel out of the dock's flow so it can move freely.
    panelEl.style.position = 'fixed';
    panelEl.style.margin = '0';
    panelEl.style.width = rect.width + 'px';
    panelEl.style.left = rect.left + 'px';
    panelEl.style.top = rect.top + 'px';
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
    panelEl.style.transform = 'none';   // drop any CSS centering transform once floating
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    moved = false;
    panelEl.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    e.preventDefault();
  };

  handleEl.addEventListener('pointerdown', onDown);
}

// Make a panel resizable via a grip in its bottom-right corner. Dragging the grip
// sets an explicit width/height on the panel (clamped to a sensible min and the
// viewport). The panel is a flex column, so the body grows/shrinks to fill; we
// drop the CSS max-height caps while a custom size is in effect.
export function makeResizable(panelEl, onChange) {
  if (panelEl.querySelector('.resize-grip')) return;
  const grip = document.createElement('div');
  grip.className = 'resize-grip';
  grip.title = 'Drag to resize this panel';
  grip.setAttribute('aria-hidden', 'true');
  panelEl.appendChild(grip);
  const body = panelEl.querySelector('.float-panel-body');

  let startX = 0, startY = 0, startW = 0, startH = 0;

  const onMove = (e) => {
    const rect = panelEl.getBoundingClientRect();
    let w = startW + (e.clientX - startX);
    let h = startH + (e.clientY - startY);
    w = Math.max(220, Math.min(w, window.innerWidth - rect.left - 8));
    h = Math.max(140, Math.min(h, window.innerHeight - rect.top - 8));
    panelEl.style.width = w + 'px';
    panelEl.style.height = h + 'px';
    panelEl.style.maxHeight = 'none';
    if (body) body.style.maxHeight = 'none';
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    panelEl.classList.remove('resizing');
    document.body.style.userSelect = '';
    if (typeof onChange === 'function') onChange();
  };

  grip.addEventListener('pointerdown', (e) => {
    const rect = panelEl.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startW = rect.width;
    startH = rect.height;
    panelEl.classList.add('resizing');
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    e.preventDefault();
    e.stopPropagation();
  });
}

// Reset all panels back to their default docked positions by clearing the inline
// styles that dragging/resizing applied (position/left/top/width/height/margin).
export function resetPanelLayout() {
  document.querySelectorAll('.float-panel').forEach(p => {
    p.style.position = '';
    p.style.left = '';
    p.style.top = '';
    p.style.right = '';
    p.style.bottom = '';
    p.style.width = '';
    p.style.height = '';
    p.style.maxHeight = '';
    p.style.margin = '';
    p.style.transform = '';
    p.classList.remove('dragging', 'resizing');
    const body = p.querySelector('.float-panel-body');
    if (body) body.style.maxHeight = '';
  });
}

// Toggle a panel's collapsed state (body hidden, header stays) via a button.
export function makeCollapsible(panelEl, btnEl, onChange) {
  const sync = () => {
    const collapsed = panelEl.classList.contains('collapsed');
    btnEl.textContent = collapsed ? '+' : '–';
    btnEl.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
  };
  btnEl.addEventListener('click', () => {
    panelEl.classList.toggle('collapsed');
    sync();
    if (typeof onChange === 'function') onChange();
  });
  sync();
}
