// SAVI — Featured Maps gallery. A friendly starting point: a small, curated set of
// ready-to-apply maps (data/featured.json, built by scraper/build_featured.js).
// Clicking a card hands the entry back to the app, which applies it with the same
// dynamic-indicator machinery used for saved maps.

let FEATURED = null;   // cached catalog

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function loadFeatured() {
  if (FEATURED) return FEATURED;
  try {
    const data = await fetch('data/featured.json').then(r => r.json());
    FEATURED = Array.isArray(data.featured) ? data.featured : [];
  } catch { FEATURED = []; }
  return FEATURED;
}

// deps = { apply(entry) }  — apply wires the entry's dynamic layers + flies the map.
export async function openFeaturedGallery(deps = {}) {
  const entries = await loadFeatured();

  // Replace any open gallery.
  const old = document.getElementById('featured-overlay');
  if (old) old.remove();

  const overlay = el('div', 'cmp-overlay open');
  overlay.id = 'featured-overlay';
  const modal = el('div', 'cmp-modal featured-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Featured Maps');

  const bar = el('div', 'cmp-bar');
  bar.appendChild(el('span', 'cmp-title', 'Featured Maps'));
  bar.appendChild(el('div', 'cmp-spacer'));
  const close = el('button', 'cmp-close', '\u00d7');
  close.title = 'Close';
  bar.appendChild(close);
  modal.appendChild(bar);

  const body = el('div', 'featured-body');
  if (!entries.length) {
    body.appendChild(el('p', 'legend-empty', 'No featured maps available yet.'));
  } else {
    const grid = el('div', 'featured-grid');
    entries.forEach(entry => {
      const card = el('button', 'featured-card');
      card.type = 'button';
      const head = el('div', 'featured-card-head');
      head.appendChild(el('span', 'featured-card-title', entry.label || entry.id));
      if (entry.category) head.appendChild(el('span', 'featured-chip', entry.category));
      card.appendChild(head);
      if (entry.description) card.appendChild(el('p', 'featured-card-desc', entry.description));
      card.addEventListener('click', async () => {
        dismiss();
        if (deps.apply) await deps.apply(entry);
      });
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const dismiss = () => overlay.remove();
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', esc); }
  });
}
