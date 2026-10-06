# SAVI Resumable Harvester — operator guide

This document explains the **`harvest.js`** tool: what it does, how to configure it, how
to run it, and how to resume it after an interruption. It is written for whoever operates
the harvest (e.g. the **Polis Center**, who owns SAVI and is extracting its own data).

`harvest.js` builds on the mechanics documented in **`SCRAPING.md`** (read that first if
you want the "why"). This guide is the practical "how to run it".

---

## 0. Before you scrape: is there an easier route? (for the Polis Center)

Scraping the Advanced Search flow (what this tool does) is the only route available to an
**outside** user, because the site's bulk export is turned off. But **as the owner of SAVI,
you likely have faster, cleaner options** — check these first:

- **Re-enable the built-in bulk export.** The site already has a bulk download page,
  `/savi/DownloadData.aspx`, but it is **commented out** in the top navigation markup, e.g.:

  ```html
  <!-- ... <telerik:RadMenuItem Text="download" NavigateUrl="/savi/DownloadData.aspx"> ... -->
  ```

  If your team re-enables that page (and confirms it still produces a full export), it would
  almost certainly beat scraping for completeness and speed. **Worth asking your dev team
  whether it can be switched back on.**

  > Note: the download button that *is* live — on the results table popup — calls
  > `window.open('/savi/Popups/download.aspx')`, which exports only the **currently displayed
  > table** (one indicator × display × year at a time, from session state, no parameters). It
  > is the same granularity this harvester already captures, so it is **not** a bulk shortcut.

- **Go to the source database.** The detailed indicator values live in the SAVI backend. A
  direct DB export by a DBA is the cleanest possible path and needs no browser at all.

- **Pull standard demographics from upstream.** Much of the demographic data originates from
  the **US Census / ACS**, which has a clean public API — easier and more precise than
  scraping for those indicators. (See also `fetch_boundaries.js`, which already pulls county
  geometry straight from the Census.)

  > **But:** SAVI-original data — e.g. **211 Helpline Calls** (from Connect2Help) — is **not**
  > in Census and exists only in SAVI. Those categories must come from SAVI (this tool)
  > regardless.

**Bottom line:** if the bulk export or a DB dump is available to you, prefer it. Use this
scraper for the SAVI-unique indicators, or whenever those easier routes aren't accessible.

---

## 1. What it produces

The harvester walks the Advanced Search flow of `https://classic.savi.org/savi/` and writes
every data point it captures as one **tidy row**, in two formats:

- **NDJSON** — one JSON object per line (good for streaming import / scripting).
- **CSV** — the same rows with a header (good for spreadsheets / bulk import).

Each row is the intersection of *indicator × geography × reporting level × display × year*:

| Column           | Meaning                                                         |
|------------------|----------------------------------------------------------------|
| `category`       | Top-level catalog category (e.g. `211 Helpline Calls`)         |
| `indicatorLabel` | The specific indicator (a tree leaf)                           |
| `indicatorPath`  | Full category path to that leaf                                |
| `geographyLevel` | Reporting level of the value (e.g. `Counties`)                 |
| `geoId`          | Geography id (FIPS / geo id), e.g. `18011`                     |
| `geoName`        | Geography name, e.g. `Boone County`                           |
| `display`        | "Display As" variant (raw count, as %, per-capita, …)          |
| `year`           | Data year                                                      |
| `value`          | The captured value (as shown in the grid, e.g. `5.97%`)        |
| `capturedAt`     | ISO timestamp of capture                                       |

Raw HTML of every captured grid is also saved under the configured `rawDir`, so any parse
can be re-checked or re-run offline.

---

## 2. How it works (in brief)

- **Unit of work = a "chunk":** a set of sibling indicator leaves under one category path.
  Selected together, they become the **columns** of one data grid (rows = geographies).
- **Fresh session per chunk:** each chunk runs in its **own isolated browser context**, so
  a chunk always starts from an empty project. (This avoids an accumulation bug where
  selections from earlier chunks would otherwise pile up in the same session.)
- **One table per combination:** within a chunk, the tool creates one table for every
  (reporting level × display × year) combination in scope, capturing and parsing each grid.
- **Resumable:** every completed cell and chunk is recorded in a **state file**. Re-running
  skips anything already done — so an interrupted run just picks up where it stopped.
- **Polite:** a configurable `delayMs` pause sits between every server interaction.

Pipeline per chunk (see `harvest.js` header comment for detail):

```
ServiceArea (pick geo type + seed geo)
  -> Select Data (get ProjectID)
  -> expand tree to the category path, tick the leaf checkboxes
  -> commit selection
  -> Table.aspx (read each item's dropdown options + VULNS ids)
  -> for each (level × display × year): set dropdowns, tick VULNS, "create tables"
  -> capture popups/table.aspx response -> parse the RadGrid -> write rows
```

---

## 3. Prerequisites

- **Node.js** (v18+) and the project dependencies installed (`npm install` in `scraper/`).
- **Playwright Chromium** plus its system libraries. On this dev box the browser libs are
  extracted locally under `.native/`; `run-harvest.sh` points the loader at them. On a
  clean machine, install them the normal way:
  ```bash
  npx playwright install chromium
  npx playwright install-deps chromium   # needs sudo; installs libnss3, libnspr4, libasound2, …
  ```
- **A real display.** The "create tables" step opens a Telerik RadWindow that only renders
  in a headed browser. Options:
  - **WSL / desktop Linux:** use the built-in display (WSLg is `:0`).
  - **Headless server:** wrap the run in `xvfb-run` (see §6).
  - `headless: true` will **not** work for value capture — leave it `false`.
- **`catalog.json`** present in `scraper/` (the indicator catalog; produced by the catalog
  enumeration stage — see `SCRAPING.md`).

---

## 4. Configuration

Config is a JSON file (default `harvest.config.json`). Pass a different file as the first
CLI argument to switch scope without editing the default.

```jsonc
{
  "headless": false,          // keep false — the RadWindow needs a real display
  "delayMs": 1500,            // politeness pause between server interactions (ms)

  "reportingTargets": [       // which geography levels to harvest, and a seed geo to pick
    { "level": "Counties", "geoTypeLabel": "Counties", "seedGeoId": "18097" }
  ],

  "scope": {
    "categories": ["211 Helpline Calls"], // [] or omit = ALL categories
    "includePaths": [],        // optional path prefixes to further narrow (see note)
    "maxGroups": 0,            // 0 = no limit on number of category groups
    "displays": "all",         // "all" or an explicit array e.g. ["as % of 211 Calls"]
    "years": "all"             // "all", { "latest": N }, or an explicit array e.g. ["2019"]
  },

  "maxLeavesPerGroup": 8,      // indicators per chunk (columns per table)
  "reloadBetweenCombos": true, // reload Table.aspx between combos (more robust, slower)

  "output": {
    "ndjson": "output/harvest_data.ndjson",
    "csv":    "output/harvest_data.csv",
    "state":  "output/harvest_state.json",
    "rawDir": "output/raw"
  }
}
```

**Field notes**

- **`reportingTargets[].level`** must match the value used in the per-indicator "Reporting
  Level" dropdown (e.g. `Counties`). `geoTypeLabel` is the label chosen in the geography-type
  dropdown on ServiceArea; `seedGeoId` is any one geo of that type used to open the project.
- **`scope.categories`** filters by the **top-level** category (first path segment). Leave
  empty/omit to harvest **everything**.
- **`scope.includePaths`** narrows further by matching a path **prefix**, using ` › ` as the
  separator, e.g. `"211 Helpline Calls › Caller Issues › Annual"`.
- **`scope.displays` / `scope.years`** — `"all"` harvests every concrete option the site
  offers for the selected items. Use an explicit array (or `{ "latest": N }` for years) to
  reduce volume.
- **`maxLeavesPerGroup`** trades table width for robustness — smaller = more, narrower
  tables (more requests); larger = fewer, wider tables.

---

## 5. Running

Use the launcher (it sets `LD_LIBRARY_PATH` for the local browser libs and defaults
`DISPLAY` to `:0`):

```bash
cd /mnt/c/temp/SAVI/scraper

# Default scope (harvest.config.json)
./run-harvest.sh

# Custom scope file
./run-harvest.sh harvest.smoke.json
```

Or run Node directly (you must provide the environment yourself):

```bash
LD_LIBRARY_PATH="$(pwd)/.native/root/usr/lib/x86_64-linux-gnu" \
DISPLAY=:0 \
node harvest.js harvest.config.json
```

You'll see per-chunk progress like:

```
=== 211 Helpline Calls › Caller Issues › Annual  [chunk 1/2, 3 items]  level=Counties ===
  ticked 3/3 leaves
  displays=1 years=1 -> up to 1 tables
  [as % of 211 Calls / 2019] 11 geos x 3 items -> 33 records

DONE. records=55 tables=2 errors=0
```

### Smoke test

`harvest.smoke.json` is a tiny scope (one group, one display, latest year) that produces a
single small table — use it to confirm the environment works before a big run:

```bash
rm -rf output/smoke_*
./run-harvest.sh harvest.smoke.json
```

Expected: a handful of tables, `errors=0`, and rows in `output/smoke_data.csv`.

---

## 6. Running on a headless server

There is no display on a bare server, so wrap the run in a virtual framebuffer:

```bash
sudo apt-get install -y xvfb          # once
xvfb-run -a ./run-harvest.sh harvest.config.json
```

Everything else is identical.

---

## 7. Resuming after an interruption

The harvest is **safe to stop and restart**:

- Press **Ctrl-C** — it finishes the current chunk gracefully (state is checkpointed after
  every cell anyway).
- The **state file** (`output/harvest_state.json`) records every completed cell and chunk.
- **Re-run the same command** — completed work is skipped and the harvest continues.

To start over from scratch, delete the output files (NDJSON, CSV, state, and `rawDir`)
before re-running. To *extend* an existing dataset (e.g. add more categories), widen the
scope in the config and re-run against the **same** state/output files — only the new work
runs.

> Because each chunk uses a fresh isolated session, resuming never risks cross-chunk
> contamination.

### Syncing only NEW data after a full harvest

Once a full harvest is complete, you don't want a re-run to re-download everything — only
to pick up what's changed. That's controlled by the **`sync`** block in the config:

```jsonc
"sync": {
  "mode": "resume",          // "resume" (default) or "refresh"
  "refreshLatestYears": 2     // in refresh mode, always re-fetch this many newest years
}
```

- **`resume` (default)** — skip every cell **and** every chunk already recorded as done.
  Only genuinely-new chunks are harvested. Use this to *finish* a first full harvest, or to
  *add* new indicators/categories (widen scope, and re-run `catalog_enum` first so new
  indicators exist in `catalog.json`).

- **`refresh` — the "sync new data" mode.** Use this for ongoing updates **after** the
  first full harvest. It:
  1. **revisits completed chunks** so newly-published years are detected and harvested, and
  2. **re-fetches the latest `refreshLatestYears` years** every run, to catch upstream
     restatements/corrections (which is where revisions almost always happen).
  Everything else already captured is skipped.

Because the output is append-only (crash-safe), a refresh run **appends** a fresh row for
each re-fetched cell. Collapse them to one row per data point (keeping the newest capture)
with the de-duplicator:

```bash
# 1. Sync: pick up new years + recent revisions
#    (set "sync": { "mode": "refresh" } in the config first)
./run-harvest.sh harvest.config.json

# 2. Collapse re-fetched rows to the latest value (idempotent)
node dedup_output.js harvest.config.json
```

`dedup_output.js` keys each data point by *indicator + reporting level + geo + display +
year* and keeps the row with the newest `capturedAt`, rewriting both the NDJSON and CSV in
place. Running it on already-clean output does nothing.

> Tip: keep `mode: "resume"` until your first full harvest is truly complete, then switch to
> `mode: "refresh"` for all subsequent scheduled syncs.

---

## 8. Output volume & scaling

- The full catalog is ~5,700 leaf indicators grouped into ~700 category groups. Multiplying
  by displays × years × reporting levels, a full harvest is **large** and long-running.
- Start narrow (one category, latest year) and widen once you're confident.
- `delayMs` is the main politeness lever. Keep it generous for a full run.
- Each captured grid's raw HTML is retained under `rawDir` so parsing can be revisited
  without re-hitting the site.

---

## 9. Files

| File                     | Role                                                        |
|--------------------------|-------------------------------------------------------------|
| `harvest.js`             | The harvester (orchestrator).                               |
| `harvest.config.json`    | Default scope/politeness/output config.                     |
| `harvest.smoke.json`     | Tiny scope for a quick end-to-end check.                    |
| `run-harvest.sh`         | Portable launcher (sets library path + display).            |
| `dedup_output.js`        | Collapse re-fetched rows to the latest value (after refresh).|
| `fetch_boundaries.js`    | Fetch county polygons (map geometry) — see below.           |
| `lib/picker.js`          | Drives the indicator TreeView (expand to path, tick leaves).|
| `lib/grid.js`            | Parses the Telerik RadGrid into rows/columns.               |
| `lib/flow.js`            | Shared flow helpers (launch, ServiceArea → Select Data).    |
| `catalog.json`           | The indicator catalog the harvester iterates.               |
| `output/`                | NDJSON, CSV, state file, and raw grid HTML.                 |

See **`SCRAPING.md`** for the underlying site mechanics and the other pipeline stages
(catalog + geography enumeration).

---

## 10. Future additions

### Indicator metadata ("About the Data")

The harvester currently captures **values only** — it does **not** pull the per-indicator
metadata (source, methodology, units, vintage). That metadata is available and could be added
later:

- On the results table popup it lives on the **"About the Data"** tab, which loads on demand
  (Summary vs FGDC documentation, toggled by the `MetadataRBL` radio → postback).
- It is also served as a standalone document at:
  ```
  /savi/Print/PrintMetadata.aspx?DataFormat=VulnMeta&IMS_CLS_COLUMNID=<id>&Type=Simple|FGDC&Title=<title>
  ```
  where `Type=Simple` is the Summary doc and `Type=FGDC` is the full FGDC record. The key
  input is each indicator's **`IMS_CLS_COLUMNID`** (its class-column id).

**To add it:** capture each indicator's `IMS_CLS_COLUMNID` while on the table page, then fetch
`PrintMetadata.aspx` once per indicator (metadata is per-indicator, independent of geography /
display / year — so it's a small, one-time pull, not per-cell). Store it alongside the values
(e.g. a `metadata/<indicatorId>.json`) for import into the new system.
