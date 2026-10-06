#!/usr/bin/env bash
# SAVI harvest ORCHESTRATOR — chains the three remaining stages, unattended:
#   Stage 1  wait for the broad/shallow run to finish (its own watchdog keeps it
#            alive; we just watch its log for DONE).
#   Stage 2  harvest per-indicator METADATA (plain GETs, no browser) — resumable.
#   Stage 3  run the FULL deep harvest (harvest.config.json: all displays x years
#            x 7 geo levels x all categories) under the watchdog until DONE.
#
# Only ONE harvester (node harvest.js) can run at a time (shared display/session),
# so the stages are strictly sequential. Every stage is resumable; if this
# orchestrator is killed, just re-run it — it re-detects where things are.
#
# Launch detached:
#   cd scraper && setsid nohup ./run-all.sh >/dev/null 2>&1 < /dev/null &
set -uo pipefail
cd "$(dirname "$0")"

SHALLOW_LOG="output/shallow_run.log"
DEEP_CFG="harvest.config.json"
DEEP_LOG="output/harvest_run.log"
DEEP_WD_LOG="output/watchdog.log"
META_LOG="output/metadata_run.log"
ORCH_LOG="output/orchestrator.log"

olog() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$ORCH_LOG"; }
is_done() { tail -n 40 "$1" 2>/dev/null | grep -qE "(^|\] )DONE\."; }

olog "orchestrator started (pid=$$)."

# ---- Stage 1: wait for the broad/shallow run to finish ----
if is_done "$SHALLOW_LOG"; then
  olog "Stage 1: broad run already DONE."
else
  olog "Stage 1: waiting for broad run (harvest.shallow.json) to log DONE..."
  while ! is_done "$SHALLOW_LOG"; do sleep 60; done
  olog "Stage 1: broad run DONE."
fi

# Make sure the shallow watchdog + harvester have fully stopped before we reuse
# the single browser session for the next stage.
while pgrep -f "watchdog-harvest.sh harvest.shallow.json" >/dev/null 2>&1; do
  olog "  waiting for shallow watchdog to exit..."; sleep 15
done
while pgrep -f "node harvest.js" >/dev/null 2>&1; do
  olog "  waiting for shallow harvester to stop..."; sleep 15
done

# ---- Stage 2: metadata (no browser/display needed — plain GETs) ----
olog "Stage 2: harvesting indicator metadata -> $META_LOG"
node harvest_metadata.js >> "$META_LOG" 2>&1
olog "Stage 2: metadata harvest finished (exit $?)."

# ---- Stage 2.5: seed the deep state from the broad run (skip re-scraping) ----
# Marks every cell the broad run already captured as done in the deep state, so
# the full deep harvest does NOT re-scrape them. Only SUCCESSFUL cells are copied
# (failed cells stay un-done and are retried); chunkDone is NOT copied (each chunk
# is re-entered to add the other displays/years). Idempotent.
olog "Stage 2.5: seeding deep state from broad run (avoid duplicate scraping)."
node seed_deep_from_shallow.js >> "$ORCH_LOG" 2>&1
olog "Stage 2.5: seed finished (exit $?)."

# ---- Stage 3: full deep harvest under the watchdog until DONE ----
if is_done "$DEEP_LOG"; then
  olog "Stage 3: deep harvest log already shows DONE — nothing to do."
else
  olog "Stage 3: starting FULL deep harvest ($DEEP_CFG) under watchdog until DONE."
  # Foreground: the watchdog loops (relaunching on crash/stall via resume) and
  # only returns once the run logs DONE. This orchestrator is itself detached.
  ./watchdog-harvest.sh "$DEEP_CFG" "$DEEP_LOG" "$DEEP_WD_LOG"
  olog "Stage 3: full deep harvest DONE."
fi

# ---- Stage 3.5: merge broad-run rows into the deep output, then de-dup ----
# Because Stage 2.5 made the deep run SKIP cells the broad run captured, those
# cells' data lives only in the broad output. Append it to the deep NDJSON and
# de-dup (keeps newest capturedAt per data point) so the final dataset is complete.
SHALLOW_NDJSON="output/shallow_data.ndjson"
if [ -s "$SHALLOW_NDJSON" ]; then
  olog "Stage 3.5: merging broad rows into deep output + de-duplicating."
  cat "$SHALLOW_NDJSON" >> "output/harvest_data.ndjson"
  node dedup_output.js "$DEEP_CFG" >> "$ORCH_LOG" 2>&1
  olog "Stage 3.5: merge + de-dup finished (exit $?)."
fi

# ---- Refresh metadata once more (the deep run captures many new indicators) ----
olog "Post: refreshing metadata to cover indicators newly seen in the deep run."
node harvest_metadata.js >> "$META_LOG" 2>&1
olog "orchestrator COMPLETE: broad + metadata + full deep harvest all done."
