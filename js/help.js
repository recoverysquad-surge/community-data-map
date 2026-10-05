// SAVI — searchable Help knowledge base.
//
// Rendered into the floating "#panel-help" panel (so it can be moved, resized,
// minimized, and toggled from the View menu like the other panels). A live search
// box sits atop a topic list (left) + the selected article (right). The content
// below is an authored, static knowledge base covering every utility in the
// Community Data Map. Because all article markup is authored here (no user input is
// interpolated), it is rendered as trusted HTML.
//
// Open from the footer's "Help" button, the toolbar View menu, or the panel toggle:
//   openHelpPanel()            — show the panel on the first article
//   openHelpPanel('export')    — show with the search prefilled

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---- Knowledge base -------------------------------------------------------
// id       stable anchor, also used for deep links
// title    shown in the list + article header
// cat      grouping heading in the topic list
// keywords extra search terms not necessarily in the visible text
// html     the article body (authored, trusted)
const ARTICLES = [
  {
    id: 'overview',
    title: 'What is the Community Data Map?',
    cat: 'Getting started',
    keywords: 'about savi polis indiana overview intro welcome what',
    html: `
      <p>The <strong>Community Data Map</strong> is an interactive map of community
      indicators for Central Indiana. It turns data harvested from
      <a href="https://classic.savi.org/savi" target="_blank" rel="noopener">SAVI</a>
      (Social Assets &amp; Vulnerabilities Indicators, a program of the Polis Center
      at Indiana University Indianapolis) into choropleth (shaded) maps you can
      explore, compare, save, and share.</p>
      <p>Everything runs in your browser. Your saved maps and preferences stay on
      your device &mdash; nothing is uploaded.</p>
      <ul>
        <li><strong>Add Data</strong> &mdash; pick an indicator to color the map.</li>
        <li><strong>Click a geography</strong> &mdash; read its values in a pop-up.</li>
        <li><strong>Save &amp; share</strong> &mdash; keep a map or copy a link to it.</li>
      </ul>`
  },
  {
    id: 'add-data',
    title: 'Adding a data layer',
    cat: 'Data & indicators',
    keywords: 'add data indicator catalog browse search category choose pick plus',
    html: `
      <p>Click <strong>Add Data</strong> (the toolbar button, or the <em>+</em> glyph
      in the Layers panel header) to open the catalog.</p>
      <ol>
        <li><strong>Browse</strong> by category folder, or type in the <strong>search
        box</strong> to find an indicator by name.</li>
        <li>Optionally set the <strong>Geography</strong> filter (see
        &ldquo;Filter the catalog by geography&rdquo;) to only show indicators that
        publish at a given reporting level.</li>
        <li>Click an indicator to add it. It appears as a new layer in the Layers
        panel and colors the map immediately.</li>
      </ol>
      <p>Add as many layers as you like; reorder them in the Layers panel to control
      what draws on top.</p>`
  },
  {
    id: 'geo-filter',
    title: 'Filter the catalog by geography',
    cat: 'Data & indicators',
    keywords: 'geography filter reporting level zip tract county school township msa blockgroup',
    html: `
      <p>In the Add Data catalog, the <strong>Geography</strong> dropdown narrows the
      list to indicators that actually have data at a chosen <em>reporting level</em>
      &mdash; for example Counties, ZIP Codes, 2010 Census Tracts, School
      Corporations, Townships, Block Groups, or Metropolitan Statistical Areas.</p>
      <p>Availability is highly level-specific (some indicators are Counties-only,
      others also publish at ZIP, etc.). When you pick a level and add an indicator,
      the layer draws at <em>that</em> geography &mdash; so choosing &ldquo;School
      Corporations&rdquo; colors school-corporation boundaries, not counties.</p>
      <p>Set it back to <strong>Any geography</strong> to see the full catalog again.</p>`
  },
  {
    id: 'variables',
    title: 'Reporting level, display & year',
    cat: 'Data & indicators',
    keywords: 'variables reporting level display year adjust selector percent rate count',
    html: `
      <p>Each data layer has an <strong>Adjust variables</strong> control (on the
      layer row) that opens selectors for:</p>
      <ul>
        <li><strong>Reporting level</strong> &mdash; the geography the values are
        summarized to (County, ZIP, Tract, &hellip;).</li>
        <li><strong>Display</strong> &mdash; how the value is expressed (e.g. a count,
        a percent of total, a rate per 1,000, per square mile).</li>
        <li><strong>Year</strong> &mdash; the time period, when multiple are
        available.</li>
      </ul>
      <p>Only combinations that exist in the data are offered, so you can&rsquo;t pick
      an empty view. Changing any selector recolors the map and updates the legend
      and pop-ups.</p>`
  },
  {
    id: 'no-data',
    title: 'Why some areas have no color',
    cat: 'Data & indicators',
    keywords: 'transparent no data missing blank uncolored gray grey empty not reported',
    html: `
      <p>A geography that does <strong>not report a value</strong> for the chosen
      indicator/level/display/year is drawn completely <strong>transparent</strong>
      &mdash; both its fill and its outline are hidden, so it disappears from the data
      layer entirely. Only geographies with reported data are shaded.</p>
      <p>This is intentional: it keeps &ldquo;no data&rdquo; visually distinct from a
      genuine low value (such as 0). If you want to still see every area&rsquo;s edges,
      add the matching <strong>Boundary overlay</strong> (Add Data &rarr; Boundaries),
      whose outlines always show.</p>`
  },
  {
    id: 'layers-panel',
    title: 'The Layers panel',
    cat: 'Layers',
    keywords: 'layers panel checkbox visibility reorder drag rename remove order stack',
    html: `
      <p>The <strong>Layers</strong> panel lists every layer on the map. For each layer
      you can:</p>
      <ul>
        <li><strong>Show / hide</strong> with the checkbox.</li>
        <li><strong>Reorder</strong> by dragging the grip (&#x283f;). The top layer
        draws on top.</li>
        <li><strong>Rename</strong> with the pencil, or by double-clicking the name.</li>
        <li><strong>Style</strong> with the gear (see &ldquo;Styling a layer&rdquo;).</li>
        <li><strong>Remove</strong> a single layer with its &times; button.</li>
      </ul>`
  },
  {
    id: 'clear',
    title: 'Clear all / Clear hidden',
    cat: 'Layers',
    keywords: 'clear all hidden remove delete wipe bulk empty reset layers',
    html: `
      <p>Two buttons in the Layers panel header remove layers in bulk:</p>
      <ul>
        <li><strong>Clear all</strong> &mdash; removes <em>every</em> layer on the map.
        You&rsquo;ll be asked to confirm, since this cannot be undone.</li>
        <li><strong>Clear hidden</strong> &mdash; removes only the layers whose
        checkbox is unchecked (not currently visible), leaving your visible layers
        untouched. Handy for tidying up after exploring.</li>
      </ul>
      <p>To clear <em>and</em> reset the view/panels, use <strong>New Map</strong>
      instead.</p>`
  },
  {
    id: 'styling',
    title: 'Styling a layer',
    cat: 'Styling',
    keywords: 'style color ramp palette opacity classify pattern outline legend gear',
    html: `
      <p>Click the <strong>gear</strong> on a layer row to open its style options:</p>
      <ul>
        <li><strong>Color ramp</strong> &mdash; choose a palette (Warm, Blues, Greens,
        Viridis, &hellip;) for choropleth shading.</li>
        <li><strong>Classification</strong> &mdash; how values are grouped into color
        classes (e.g. quantile vs. equal interval).</li>
        <li><strong>Opacity</strong> &mdash; how solid the fill is, so you can see
        layers beneath.</li>
        <li><strong>Pattern / outline</strong> &mdash; fill patterns and edge color for
        overlapping polygon layers.</li>
      </ul>
      <p>The legend updates to match whatever styling you choose.</p>`
  },
  {
    id: 'legend',
    title: 'Reading the legend',
    cat: 'Styling',
    keywords: 'legend key classes colors ranges swatch',
    html: `
      <p>The <strong>Legend</strong> panel shows the color classes for each active data
      layer &mdash; the value range each shade represents. It updates automatically
      when you change an indicator, display, year, ramp, or classification.</p>
      <p>Hide or show the Legend from the toolbar toggle or the View menu.</p>`
  },
  {
    id: 'popups',
    title: 'Pop-ups & details',
    cat: 'Layers',
    keywords: 'popup pop-up click details value tooltip geography info',
    html: `
      <p>Click any shaded geography to open a <strong>pop-up</strong> with its name and
      the value(s) for the active layer(s), including the display and year. Click
      elsewhere or press <kbd>Esc</kbd> to close it.</p>`
  },
  {
    id: 'boundaries',
    title: 'Boundary overlays',
    cat: 'Geographies',
    keywords: 'boundaries outline counties tracts zip school township msa blockgroup overlay',
    html: `
      <p>Under <strong>Add Data &rarr; Boundaries</strong> you can add outline-only
      overlays for any of the SAVI geography levels (Counties, Census Tracts, Block
      Groups, Townships, School Corporations, ZIP Code Tabulation Areas, Metropolitan
      Statistical Areas).</p>
      <p>These draw the geography edges without shading &mdash; useful as a reference
      frame on top of a choropleth or the basemap.</p>`
  },
  {
    id: 'places',
    title: 'Places & points (pins)',
    cat: 'Places & import',
    keywords: 'places points pins marker drop location address my places',
    html: `
      <p><strong>Places</strong> layers hold point markers (pins). You can drop pins on
      the map and give them names and notes; they&rsquo;re grouped into a &ldquo;My
      Places&rdquo; layer you can style, rename, and toggle like any other layer.</p>
      <p>Import many points at once from a spreadsheet with <strong>Import &rarr;
      Places (CSV)</strong>.</p>`
  },
  {
    id: 'import',
    title: 'Importing your own data',
    cat: 'Places & import',
    keywords: 'import geojson kml csv upload file bring your own data places',
    html: `
      <p>From the <strong>Map</strong> menu (or hamburger on mobile) &rarr;
      <strong>Import Data</strong>:</p>
      <ul>
        <li><strong>GeoJSON / KML</strong> &mdash; add your own polygons, lines, or
        points as a new layer. You can restyle and reorder it like built-in layers.</li>
        <li><strong>Places (CSV)</strong> &mdash; turn a spreadsheet of locations into
        pins. A sample CSV is linked in the import dialog to show the expected
        columns.</li>
      </ul>
      <p>Imported data is stored inside your saved map on this device.</p>`
  },
  {
    id: 'save',
    title: 'Saving maps',
    cat: 'Saving & sharing',
    keywords: 'save map named saved maps device autosave persist store',
    html: `
      <p>Use <strong>Map &rarr; Save Map</strong> to store the current map (layers,
      styling, view, places, imports) under a name on your device. Reopen any saved
      map from <strong>Map &rarr; Saved Maps</strong>.</p>
      <p><strong>Autosave</strong> (toggle in the Map menu) keeps your current map
      up to date automatically, so a refresh restores your last work. Turn it off if
      you prefer to save manually.</p>`
  },
  {
    id: 'share',
    title: 'Sharing a link',
    cat: 'Saving & sharing',
    keywords: 'share link permalink copy url send view hash',
    html: `
      <p><strong>Share</strong> (or <strong>Copy Shareable Link</strong>) encodes the
      entire current view into a URL. Anyone who opens that link sees the same map &mdash;
      same layers, styling, and extent &mdash; without needing your saved copy.</p>
      <p>On phones, Share hands off to the native share sheet; elsewhere the link is
      copied to your clipboard and shown in the address bar.</p>`
  },
  {
    id: 'new-map',
    title: 'Starting a New Map',
    cat: 'Saving & sharing',
    keywords: 'new map blank fresh clear start over reset reload',
    html: `
      <p><strong>New Map</strong> clears the current map &mdash; all data layers,
      places, points, and imports &mdash; and starts fresh. It also drops any shared
      link from the address bar so you begin with a clean slate.</p>
      <p>If you want to keep your current work, Save it first. New Map does not delete
      your previously saved maps; find them under <strong>Saved Maps</strong>.</p>`
  },
  {
    id: 'basemap',
    title: 'Switching the basemap',
    cat: 'Getting started',
    keywords: 'basemap background satellite light dark streets tiles',
    html: `
      <p>The <strong>Basemap</strong> panel switches the background map (for example a
      light canvas vs. satellite imagery). Choose whichever makes your data read best;
      the data layers draw on top unchanged.</p>`
  },
  {
    id: 'compare-table',
    title: 'Compare (table view)',
    cat: 'Tools',
    keywords: 'compare table data grid rows export csv values side by side',
    html: `
      <p><strong>Compare</strong> opens a table of the active indicator values across
      all geographies &mdash; useful for ranking and side-by-side reading. You can
      export the table as data (CSV/GeoJSON) from the Export menu.</p>`
  },
  {
    id: 'profile',
    title: 'Community Profile',
    cat: 'Tools',
    keywords: 'profile community place summary report dashboard charts',
    html: `
      <p><strong>Community Profile</strong> gives a one-place summary for a selected
      geography &mdash; key indicators and charts drawn from the loaded data &mdash;
      so you can read a single place in depth rather than one indicator across many
      places.</p>`
  },
  {
    id: 'timeline',
    title: 'Timeline (year scrubber)',
    cat: 'Tools',
    keywords: 'timeline time year animate play scrub slider over time trend',
    html: `
      <p>When an indicator has multiple years, the <strong>Timeline</strong> panel lets
      you scrub or play through them to watch change over time. Use the play button to
      animate; set loop/speed from the timeline controls.</p>`
  },
  {
    id: 'swipe',
    title: 'Swipe compare',
    cat: 'Tools',
    keywords: 'swipe compare split slider two layers before after left right',
    html: `
      <p><strong>Swipe</strong> splits the map so you can drag a divider to compare two
      layers (or two time periods) directly &mdash; one on each side of the slider.</p>`
  },
  {
    id: 'export',
    title: 'Exporting the map & data',
    cat: 'Export',
    keywords: 'export image png pdf print data geojson csv download save file',
    html: `
      <p>The <strong>Export</strong> menu offers:</p>
      <ul>
        <li><strong>Image (PNG)</strong> &mdash; a snapshot of the current map with the
        legend.</li>
        <li><strong>PDF (print)</strong> &mdash; a print-ready page including the SAVI
        data attribution.</li>
        <li><strong>Data (GeoJSON / CSV)</strong> &mdash; the underlying values for the
        active layer(s).</li>
      </ul>`
  },
  {
    id: 'view-layout',
    title: 'Panels, View menu & layout',
    cat: 'Getting started',
    keywords: 'view menu panels show hide drag move resize reset layout docks collapse',
    html: `
      <p>Every panel (Basemap, Layers, Legend, Timeline) can be dragged, collapsed,
      resized, or closed. Toggle panels from the <strong>View</strong> menu or the
      toolbar buttons.</p>
      <p><strong>Reset Layout</strong> returns panels to their default positions;
      <strong>Reset View</strong> returns the map to its starting extent.</p>`
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    cat: 'Help',
    keywords: 'troubleshoot problem issue bug refresh cache not updating blank stuck fix',
    html: `
      <p><strong>The map looks out of date after an update.</strong> Do a hard refresh
      to clear the cache: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> (Windows/Linux)
      or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> (Mac).</p>
      <p><strong>New Map didn&rsquo;t clear everything.</strong> Make sure the address
      bar has no <code>#m=</code> link on it (that&rsquo;s a shared view). New Map now
      drops it automatically after a hard refresh.</p>
      <p><strong>An area has no color.</strong> That geography has no reported value for
      the current selection &mdash; see &ldquo;Why some areas have no color.&rdquo;</p>
      <p><strong>My saved maps are gone.</strong> Saved maps live in this browser on
      this device. A different browser, device, or clearing site data won&rsquo;t have
      them.</p>`
  }
];

// Strip tags to a plain-text haystack for searching.
function plain(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || '').toLowerCase();
}
const INDEX = ARTICLES.map(a => ({
  a,
  hay: (a.title + ' ' + a.cat + ' ' + (a.keywords || '') + ' ' + plain(a.html)).toLowerCase()
}));

// Build the search box + topic list + article pane into the panel body once.
// Returns a small controller so the open function can drive search/focus.
function buildHelp(root) {
  root.innerHTML = '';

  // Search box sits at the top of the panel body (the panel header holds the
  // title + minimize/close, so search lives here).
  const searchWrap = el('div', 'help-search-wrap');
  const search = el('input', 'help-search');
  search.type = 'search';
  search.placeholder = 'Search help\u2026';
  search.setAttribute('aria-label', 'Search help');
  searchWrap.appendChild(search);
  root.appendChild(searchWrap);

  // Body: topic list (left) + article (right).
  const body = el('div', 'help-body');
  const list = el('div', 'help-list');
  list.setAttribute('role', 'navigation');
  const article = el('div', 'help-article');
  article.setAttribute('role', 'document');
  article.tabIndex = 0;
  body.appendChild(list);
  body.appendChild(article);
  root.appendChild(body);

  let currentId = ARTICLES[0].id;

  function showArticle(id) {
    const found = ARTICLES.find(a => a.id === id);
    if (!found) return;
    currentId = id;
    article.innerHTML = `<h2 class="help-h2">${found.title}</h2>` + found.html;
    article.scrollTop = 0;
    list.querySelectorAll('.help-link').forEach(b =>
      b.classList.toggle('active', b.dataset.id === id));
  }

  function renderList(q) {
    const query = (q || '').trim().toLowerCase();
    const matches = query
      ? INDEX.filter(x => query.split(/\s+/).every(t => x.hay.includes(t))).map(x => x.a)
      : ARTICLES;
    list.innerHTML = '';
    if (!matches.length) {
      list.appendChild(el('p', 'help-empty', 'No help topics match your search.'));
      return;
    }
    // Group by category, preserving first-seen order.
    const cats = [];
    const byCat = {};
    matches.forEach(a => {
      if (!byCat[a.cat]) { byCat[a.cat] = []; cats.push(a.cat); }
      byCat[a.cat].push(a);
    });
    cats.forEach(cat => {
      list.appendChild(el('div', 'help-cat', cat));
      byCat[cat].forEach(a => {
        const b = el('button', 'help-link', a.title);
        b.type = 'button';
        b.dataset.id = a.id;
        b.addEventListener('click', () => showArticle(a.id));
        list.appendChild(b);
      });
    });
    // Keep the current article highlighted if it's still in the list; otherwise
    // jump to the first match so the right pane always reflects the list.
    if (matches.some(a => a.id === currentId)) showArticle(currentId);
    else showArticle(matches[0].id);
  }

  search.addEventListener('input', () => renderList(search.value));
  renderList('');

  root._search = search;
  root._render = renderList;
}

// Show the Help panel (building its content on first open) and focus the search.
// Pass a query to prefill/filter the topic list.
export function openHelpPanel(initialQuery = '') {
  const panel = document.getElementById('panel-help');
  if (!panel) return;
  panel.classList.remove('hidden', 'collapsed');
  // Restore any height that collapsing stashed, so re-opening isn't header-only.
  if (panel.dataset.savedHeight) {
    panel.style.height = panel.dataset.savedHeight;
    delete panel.dataset.savedHeight;
  }
  const collapseBtn = panel.querySelector('.collapse-btn');
  if (collapseBtn) { collapseBtn.textContent = '\u2013'; collapseBtn.setAttribute('aria-label', 'Collapse panel'); }

  const root = panel.querySelector('#help-root');
  if (root && !root._render) buildHelp(root);
  if (root && root._render) {
    root._search.value = initialQuery || '';
    root._render(root._search.value);
    setTimeout(() => root._search.focus(), 30);
  }
}
