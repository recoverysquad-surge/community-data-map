// SAVI — "About the Data" panel. Shows what we know about an indicator from the
// harvested catalog: its category, breadcrumb path, and an availability matrix
// (reporting level -> displays -> year range). Detailed source/methodology/units are
// NOT harvested; those live on the classic SAVI site, which we link out to.

import { getIndicator, availableLevels, availableDisplays, availableYears } from './dataset.js?v=96';
import { makeDraggable } from './panels.js?v=96';

const CLASSIC_URL = 'https://classic.savi.org/savi';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Compact a sorted year list to a range string ("2016–2019" or "2016, 2018").
function yearSummary(years) {
  if (!years.length) return '';
  const ys = years.map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (ys.length !== years.length) return years.join(', ');
  const contiguous = ys.every((y, i) => i === 0 || y === ys[i - 1] + 1);
  return contiguous && ys.length > 1 ? `${ys[0]}\u2013${ys[ys.length - 1]}` : ys.join(', ');
}

export function openMetadataModal(indicatorId) {
  const ind = getIndicator(indicatorId);
  if (!ind) return;

  // A fresh window each time (indicator-specific); replace any that's open.
  const existing = document.getElementById('meta-window');
  if (existing) existing.remove();

  // A movable, non-blocking floating window (like the geography info-window) — the header is
  // the drag handle and the close X sits on the far RIGHT (consistent with every window).
  const win = el('div', 'meta-window');
  win.id = 'meta-window';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'About the Data');

  const header = el('div', 'meta-window-header');
  const close = el('button', 'meta-window-close', '\u00d7');
  close.type = 'button';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close');
  header.appendChild(el('span', 'meta-window-title', 'About the Data'));
  header.appendChild(close);                              // title left, close X far right

  const body = el('div', 'catalog-body meta-body');

  body.appendChild(el('h3', 'meta-title', ind.label));
  const meta = el('div', 'meta-facts');
  const addFact = (k, v) => {
    if (!v) return;
    const row = el('div', 'meta-fact');
    row.appendChild(el('span', 'meta-k', k));
    row.appendChild(el('span', 'meta-v', v));
    meta.appendChild(row);
  };
  addFact('Category', ind.category);
  addFact('Location', ind.path);
  body.appendChild(meta);

  // Availability matrix: one block per reporting level.
  const levels = availableLevels(indicatorId);
  if (levels.length) {
    body.appendChild(el('div', 'meta-section-title', 'Availability'));
    const table = el('table', 'meta-avail');
    const thead = el('thead');
    const htr = el('tr');
    htr.appendChild(el('th', null, 'Reporting Level'));
    htr.appendChild(el('th', null, 'Display As'));
    htr.appendChild(el('th', null, 'Years'));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    levels.forEach(level => {
      const displays = availableDisplays(indicatorId, level);
      displays.forEach((display, i) => {
        const tr = el('tr');
        if (i === 0) {
          const lvTd = el('td', 'meta-avail-level', level);
          lvTd.rowSpan = displays.length;
          tr.appendChild(lvTd);
        }
        tr.appendChild(el('td', null, display));
        tr.appendChild(el('td', 'meta-avail-years', yearSummary(availableYears(indicatorId, level, display))));
        tbody.appendChild(tr);
      });
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }

  // Source note + link out to the authoritative classic-site metadata.
  const note = el('div', 'meta-note');
  note.appendChild(el('p', null,
    'Detailed source, methodology, units, and definitions for this indicator are ' +
    'published on the SAVI (Social Assets and Vulnerabilities Indicators) platform by ' +
    'the Polis Center at IUPUI.'));
  const link = el('a', 'meta-link', 'Open the classic SAVI site \u2197');
  link.href = CLASSIC_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  note.appendChild(link);
  body.appendChild(note);

  win.appendChild(header);
  win.appendChild(body);
  document.body.appendChild(win);

  // Center on open, clamped to the viewport; then draggable by its header.
  const w = win.offsetWidth, h = win.offsetHeight;
  win.style.left = Math.max(8, Math.round((window.innerWidth - w) / 2)) + 'px';
  win.style.top = Math.max(8, Math.round((window.innerHeight - h) / 3)) + 'px';
  makeDraggable(win, header);

  const dismiss = () => {
    win.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
}
