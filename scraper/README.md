# SAVI Advanced Search — Playwright scraper (prototype)

Scrapes the classic SAVI Advanced Search flow for **one geography** and writes the
resulting data table(s) to CSV. Built because the detailed indicator data has **no
direct API** — it's rendered by ASP.NET WebForms / Telerik postbacks tied to session
state (and `DownloadData.aspx` is disabled). A real browser carries the session for us.

## Files
- `scrape.js` — the scraper (walks ServiceArea → Select Data → Tables → CSV).
- `discover.js` — dumps live DOM structure (selects, buttons, tabs, hidden fields,
  data-bearing network calls) + a screenshot. Run this first if selectors need tuning.
- `artifacts/` — per-step screenshots + HTML snapshots written on every run (for debugging).

## One-time setup (needs sudo)
Chromium is installed, but 4 system libraries are missing on this machine.
Install the browser dependencies (either command works):

```bash
# Option A — Playwright helper (recommended)
sudo npx playwright install-deps chromium

# Option B — just the missing libs
sudo apt-get update && sudo apt-get install -y libnss3 libnspr4 libasound2t64
```

(Missing libs detected: `libnss3.so`, `libnssutil3.so`, `libnspr4.so`, `libasound.so.2`.)

## Run
```bash
cd /mnt/c/temp/SAVI/scraper
node discover.js          # optional: confirm live selectors, saves discover_*.png/html
node scrape.js            # run the scrape -> savi_output.csv
HEADLESS=false node scrape.js   # watch it (needs a display or xvfb-run)
```

## Configure (top of scrape.js)
- `selectionMode`: `'address'` (type an address, click Find — most reliable) or
  `'geoid'` (inject a known SAVI geo id directly).
- `address` / `geoId`: the single geography to pull.
- `geographyOptionText`: which geography-type to choose (e.g. `Census Tract`).
- `indicators`: indicator labels to check in the Select Data tree.
- `outCsv`: output path.

## Confirmed vs. needs-a-live-run
Confirmed from the live markup and baked into the script:
- Geography dropdown `#ctl00_ContentPlaceHolder1_Dpl`
- Address fields + Find button, hidden `SaveSelectedGeos`
- `GetGeoSelections.aspx` returns the selected polygon + geo id (`gi`)
- "Select Data" is a plain link that advances the flow

Needs confirmation on the first real run (the indicator tree + results grid only
render with a live session — the script uses label-based matching + generic table
extraction and saves artifacts so you can tune selectors):
- Exact indicator-tree checkbox structure on SelectData.aspx
- Exact results-grid control on Table.aspx

After one run, open `artifacts/04_indicators_selected.html` and
`artifacts/07_tables_loaded.html` to lock in precise selectors if needed.

## Scaling later
Once one geography works end-to-end, loop over geo ids (or addresses) and append each
result to a combined CSV — and keep request rates polite.
```
```
