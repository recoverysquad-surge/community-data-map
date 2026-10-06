# SAVI Data Scraping — how it works & how to run it

This document explains how the `scraper/` tooling extracts data from the classic SAVI
site (`https://classic.savi.org/savi/`) so it can be imported into the new MapLibre
system, and the exact steps to run each stage.

---

## 1. Why scraping is required

The classic SAVI portal is a legacy **ASP.NET WebForms + Telerik + Google Maps** app.
The detailed indicator data has **no public API**:

- `DownloadData.aspx` (bulk export) is disabled (commented out in the page markup).
- `MapInformationService.asmx` only exposes `GetMapID`.
- Detailed values are rendered by **session-stateful postbacks** through the Advanced
  Search flow, not served as data.

So the only reliable way to get the detailed numbers is to **drive a real browser**
(Playwright) that carries the ASP.NET session, walk the same flow a human would, and
capture the resulting data grid.

> Boundary geometry and high-level summary facts *can* be pulled more directly
> (`LocalServices/GetGeoSelections.aspx` for polygons, `CommunityProfiles.aspx` for
> summary facts), but the detailed indicators require the flow below.

---

## 2. The data model

Every data point is the intersection of:

| Dimension       | Where it comes from                                    |
|-----------------|--------------------------------------------------------|
| **Indicator**   | The data-item catalog (5,893 items) — `catalog.json`   |
| **Geography**   | 11 Central Indiana counties (+ tracts/ZCTAs/etc.) — `geographies.json` |
| **Reporting level** | Per-indicator dropdown (e.g. Counties, MSA, ZIP)   |
| **Display As**  | Per-indicator dropdown (raw count, as %, per-capita…)  |
| **Year**        | Per-indicator dropdown                                  |

Important: **each indicator only supports certain reporting levels.** For example the
"211 Helpline Calls" indicators report at Counties/MSA/ZIP but **not** census tracts.
The service-area geography you pick must match a level the indicator supports, or the
grid returns zero rows.

---

## 3. The reverse-engineered pipeline

The full path to real numbers (all confirmed working):

1. **ServiceArea.aspx** — pick a geography type and commit a geography selection.
   - Geography-type dropdown: `#ctl00_ContentPlaceHolder1_Dpl`
   - Selected geos accumulate in hidden field `#ctl00_ContentPlaceHolder1_SaveSelectedGeos`
     (comma-separated internal geo ids), committed via `#ctl00_ContentPlaceHolder1_MapSearch`.
   - Then follow the **"Select Data"** link → yields a **ProjectID** (session scope).

2. **SelectData.aspx (picker popup)** — an ASP.NET **TreeView** with
   populate-on-demand. Tick the **true-leaf** indicator items (a checkbox with no
   expand arrow), then click `#ctl00_ContentPlaceHolder1_Select` ("update selected
   items") to commit them to the project.
   - The tree renumbers node ids (`t<N>`/`n<N>`) after every postback, so expansion
     must be keyed by the stable **postback ARG path**, not the id. This is what
     `catalog_enum.js` does to enumerate all 5,893 items.

3. **Table.aspx (config grid)** — this is a **configuration** page, not the data yet.
   Each selected indicator is a row with three **autopostback** `<select>`s keyed by a
   stable numeric `itemId`:
   - `Geography___<itemId>_1` — reporting level
   - `NORM___<itemId>_1` — Display As
   - `Years___<itemId>_1` — year

   Each selection triggers a **full-page postback** (must wait for navigation). The page
   also has `input[name="VULNS"]` **checkboxes** whose values are per-project selection
   *instance* ids (e.g. `5275100`).

4. **"create tables"** button `#Tables` → JS `ShowTableDataWindow()`:
   - It first runs `validateItemOptionsTable()` (in `Scripts/DataSelect.js`).
   - **Validation only passes if:** at least one `VULNS` checkbox is `.checked`, AND
     every checked item has a **concrete** (non-`*`) reporting level, Display, and year,
     AND all checked items share the **same** reporting level.
   - When it passes, it calls
     `openRadWindow('/savi/popups/table.aspx?vulns=<inst1>|<inst2>|&others=', …)`
     which fetches the **actual data grid** as an in-app child request.

### The key gotcha (why headless/earlier attempts failed)

`validateItemOptionsTable()` **silently returns false** — with no popup and no network
request — unless the `VULNS` checkboxes are actually **checked**. Setting only the
dropdowns is not enough. The working order is:

1. Set all three dropdowns per item to concrete values (they autopostback; the server
   persists them).
2. **Then** tick every `VULNS` checkbox client-side (no postback in between).
3. Click `#Tables`.

The data grid arrives as:

```
GET /savi/popups/table.aspx?vulns=<inst1>|<inst2>|&others=&rwndrnd=<random>   → 200
```

Response structure (parseable HTML table):

- `<th>` columns: `County | County ID | <indicator label> | <indicator label> …`
- `<td>` rows: one per geography (e.g. `Boone County | 18011 | 5.97% | 0.885%`)
- Footer: `Displaying N items.`

**This must run headed** (a visible browser). In this WSL environment that means
`DISPLAY=:0` (WSLg). Headless never surfaced the RadWindow popup.

---

## 4. Files

| File | Purpose |
|------|---------|
| `lib/flow.js` | Shared helpers: `launch()`, `setGeographyType()`, `selectAndCommitGeo()`, `gotoSelectData()`, geo-type map, base URLs. |
| `catalog_enum.js` | Enumerates the full indicator tree → **`catalog.json`** (5,893 items). |
| `catalog.json` | The complete data-item catalog (label + category path per item). |
| `geographies.json` | The 11 counties (FIPS) + geography-type metadata. |
| `probe_table.js` | Dumps the Table.aspx config grid (dropdowns, VULNS ids). |
| `probe_data.js` / `probe_data_county.js` | Earlier headless attempts at the values popup (kept for reference). |
| `probe_data_headed.js` | **Working** end-to-end: headed run + network capture + the VULNS-checkbox fix. Confirms real value extraction. |
| `artifacts/` | Per-step screenshots, HTML snapshots, captured responses (`net_table_*.html`), parsed JSON. |

---

## 5. One-time environment setup

Chromium is installed but a few system libraries are needed. In this environment they
were extracted locally (no root) under `scraper/.native/root`. Any Node run that
launches the browser must point `LD_LIBRARY_PATH` at them:

```bash
export LD_LIBRARY_PATH="/mnt/c/temp/SAVI/scraper/.native/root/usr/lib/x86_64-linux-gnu"
```

On a machine with root, the simpler alternative is:

```bash
sudo npx playwright install-deps chromium
# or: sudo apt-get install -y libnss3 libnspr4 libasound2t64
```

Headed runs need a display. Under WSLg it is `DISPLAY=:0`; otherwise use `xvfb-run`.

---

## 6. How to run each stage

All commands from `cd /mnt/c/temp/SAVI/scraper`.

### 6a. Build the indicator catalog (already done → `catalog.json`)

```bash
LD_LIBRARY_PATH=/mnt/c/temp/SAVI/scraper/.native/root/usr/lib/x86_64-linux-gnu \
  node catalog_enum.js
```

### 6b. Inspect the Table.aspx config grid

```bash
LD_LIBRARY_PATH=/mnt/c/temp/SAVI/scraper/.native/root/usr/lib/x86_64-linux-gnu \
  node probe_table.js
# → artifacts/probe_data_config.json  (itemIds, available levels/years, VULNS ids)
```

### 6c. Extract real data values (the confirmed working path) — HEADED

```bash
LD_LIBRARY_PATH=/mnt/c/temp/SAVI/scraper/.native/root/usr/lib/x86_64-linux-gnu \
DISPLAY=:0 \
  node probe_data_headed.js
```

Outputs:
- `artifacts/net_table_0.html` — the raw captured data-grid response.
- `artifacts/probe_data_parsed.json` — the grid parsed into rows.
- `artifacts/probe_headed_netlog.json` — the captured `popups/table.aspx` request(s).
- `artifacts/probe_headed.png` — screenshot.

The console prints the biggest parsed table, e.g.:

```
County | County ID | 2019 …Mental Health Issues as % of 211 Calls | 2019 …Domestic Violence as % of 211 Calls
Boone County   18011  5.97%  0.885%
…
Marion County  18097  1.52%  1.05%
Displaying 11 items.
```

---

## 7. Scaling to a full harvest (not yet run)

A full crawl would loop the section-3 pipeline over
`catalog.json` × `geographies.json` × supported levels × years, capturing each
`popups/table.aspx` response and normalizing the grid into rows keyed by
`(indicator, geography, level, display, year)`.

**Deliberately not run yet.** The matrix is very large (thousands of indicators × their
years/levels × geographies) and each interaction is seconds-to-minutes of postback
against a **public nonprofit (IU Polis Center)** server. Before a bulk run:

- Rate-limit and add polite delays (the probes already sleep between actions).
- Scope to the indicators/geographies actually needed for the new system.
- Make the harvester **resumable** (checkpoint completed cells so it can restart).
- Prefer, where possible, **upstream sources** (US Census ACS/TIGER) that much of SAVI
  derives from, and/or request a **bulk export** from SAVI / IU Polis Center directly.
