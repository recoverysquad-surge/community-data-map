// SAVI — first-run Welcome card. A one-time, dismissible intro that orients new
// visitors (what SAVI is + three quick tips) and offers two fast starts: browse
// Featured Maps or add data. Shown automatically on the first visit (gated by a
// localStorage flag) and re-openable any time from the Help (?) button.

const FLAG = 'savi.welcomed';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function hasWelcomed() {
  try { return localStorage.getItem(FLAG) === '1'; } catch { return false; }
}

function markWelcomed() {
  try { localStorage.setItem(FLAG, '1'); } catch { /* ignore */ }
}

// deps = { onBrowseFeatured, onAddData }
export function openWelcomeCard(deps = {}) {
  const old = document.getElementById('welcome-overlay');
  if (old) old.remove();

  const overlay = el('div', 'cmp-overlay open');
  overlay.id = 'welcome-overlay';
  const modal = el('div', 'cmp-modal welcome-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Welcome to the Community Data Map');

  const body = el('div', 'welcome-body');
  body.appendChild(el('h2', 'welcome-title', 'Welcome to the Community Data Map'));
  body.appendChild(el('p', 'welcome-lead',
    'Explore community data across Central Indiana on one interactive map \u2014 '
    + 'toggle indicators, compare places, and share what you find.'));

  const tips = el('ul', 'welcome-tips');
  [
    ['Add Data', 'pick indicators to color the map.'],
    ['Click a geography', 'see its details in a pop-up.'],
    ['Save & share', 'keep your map or copy a link to it.']
  ].forEach(([k, v]) => {
    const li = el('li');
    li.appendChild(el('strong', null, k + ' \u2014 '));
    li.appendChild(document.createTextNode(v));
    tips.appendChild(li);
  });
  body.appendChild(tips);

  const actions = el('div', 'welcome-actions');
  const featuredBtn = el('button', 'tb-btn tb-primary', 'Browse Featured Maps');
  featuredBtn.type = 'button';
  const addBtn = el('button', 'tb-btn', 'Add Data');
  addBtn.type = 'button';
  const gotBtn = el('button', 'welcome-dismiss', 'Got it');
  gotBtn.type = 'button';
  actions.appendChild(featuredBtn);
  actions.appendChild(addBtn);
  actions.appendChild(gotBtn);
  body.appendChild(actions);

  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const dismiss = () => { markWelcomed(); overlay.remove(); };
  featuredBtn.addEventListener('click', () => { dismiss(); if (deps.onBrowseFeatured) deps.onBrowseFeatured(); });
  addBtn.addEventListener('click', () => { dismiss(); if (deps.onAddData) deps.onAddData(); });
  gotBtn.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', esc); }
  });
}
