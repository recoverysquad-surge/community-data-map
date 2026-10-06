#!/usr/bin/env bash
# Rebuild the app's data/ from the latest harvest output, then (if anything
# changed) commit + push so the hosted site picks up fresh data.
#
# Usage:
#   ./refresh_and_deploy.sh            # one-shot: rebuild, commit, push
#   WATCH=1 ./refresh_and_deploy.sh    # loop forever, refreshing every $INTERVAL sec
#
# Env:
#   INTERVAL   seconds between refreshes in WATCH mode (default 1800 = 30 min)
#   NO_PUSH=1  rebuild + commit locally but don't push (dry-run of the data build)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INTERVAL="${INTERVAL:-1800}"

refresh_once() {
  echo "[$(date '+%H:%M:%S')] rebuilding data/ from latest harvest…"
  ( cd "$SCRIPT_DIR" && node build_savi_dataset.js )

  cd "$REPO_ROOT"
  # Stage only the published data (geometry + index + per-indicator values).
  git add data/savi_index.json data/values data/geo_counties.geojson data/counties.geojson 2>/dev/null || true

  if git diff --cached --quiet; then
    echo "[$(date '+%H:%M:%S')] no data changes — nothing to deploy."
    return 0
  fi

  local n
  n="$(node -e "const d=require('./data/savi_index.json'); console.log((d.indicators||[]).length)" 2>/dev/null || echo '?')"
  git commit -q -m "data: refresh harvested dataset ($n indicators) — $(date '+%Y-%m-%d %H:%M')"
  echo "[$(date '+%H:%M:%S')] committed data refresh ($n indicators)."

  if [ "${NO_PUSH:-0}" = "1" ]; then
    echo "[$(date '+%H:%M:%S')] NO_PUSH=1 — skipping push."
  else
    git push -q && echo "[$(date '+%H:%M:%S')] pushed → live site will update shortly."
  fi
}

if [ "${WATCH:-0}" = "1" ]; then
  echo "WATCH mode: refreshing every ${INTERVAL}s. Ctrl-C to stop."
  while true; do
    refresh_once || echo "[$(date '+%H:%M:%S')] refresh failed (will retry next cycle)."
    sleep "$INTERVAL"
  done
else
  refresh_once
fi
