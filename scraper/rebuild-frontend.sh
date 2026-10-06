#!/usr/bin/env bash
# Rebuild the map's data from the latest harvest outputs. Safe to run any time — even while the
# harvester is still going (it reads whatever rows exist so far). No browser/display needed.
#
# Reads: output/harvest_data.ndjson (deep) + output/shallow_data.ndjson (broad)
# Writes: ../data/savi_index.json, ../data/values/<id>.json, ../data/geo_counties.geojson
#
# The running map picks the new data up on a normal page reload (python http.server revalidates
# the un-versioned data files by mtime), so you don't need to bump the ?v= cache version.
set -euo pipefail
cd "$(dirname "$0")"

echo "Rebuilding SAVI frontend dataset from harvest output..."
node build_savi_dataset.js

echo
echo "Done. Reload http://localhost:8000 (Ctrl/Cmd-Shift-R for a hard refresh) to see the new data."
