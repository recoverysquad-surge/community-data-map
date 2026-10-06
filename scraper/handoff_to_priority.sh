#!/usr/bin/env bash
# One-shot handoff: wait for the SAMPLE harvest to finish, then cleanly relaunch the PRIORITY
# harvest with 6 workers + its watchdog. Fully detached (run via nohup). No duplicate scraping:
# a final merge folds sample shard state into master, then shards re-seed from master.
set -uo pipefail
cd "$(dirname "$0")"

LOG="output/handoff.log"
SAMPLE_WD_PID="${SAMPLE_WD_PID:-0}"
STUCK_MAX="${STUCK_MAX:-1800}"   # if sample makes no progress this long, hand off anyway
log(){ echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

log "handoff started (sample watchdog pid=$SAMPLE_WD_PID). Waiting for sample completion..."

# 1) Wait until the sample scope is complete (remaining==0) or clearly stalled.
last=-1; stuck=0
while true; do
  rem="$(node remaining_chunks.js harvest.sample.json 6 2>/dev/null || echo -1)"
  if [ "$rem" = "0" ]; then log "sample COMPLETE (remaining=0)."; break; fi
  if [ "$rem" = "$last" ]; then stuck=$((stuck+60)); else stuck=0; last="$rem"; fi
  if [ "$stuck" -ge "$STUCK_MAX" ]; then
    log "sample STALLED at remaining=$rem for ${stuck}s — proceeding to priority anyway."; break
  fi
  sleep 60
done

# 2) Tear down ALL sample processes cleanly (by explicit PID where possible; no broad self-match).
if [ "$SAMPLE_WD_PID" != "0" ] && kill -0 "$SAMPLE_WD_PID" 2>/dev/null; then
  log "stopping sample watchdog pid $SAMPLE_WD_PID."; kill "$SAMPLE_WD_PID" 2>/dev/null; sleep 2
fi
rp="$(pgrep -f 'run-parallel\.sh 6 harvest.sample' | head -1 || true)"
if [ -n "${rp:-}" ]; then log "stopping sample run-parallel pid $rp."; kill "$rp" 2>/dev/null; sleep 2; fi
# workers/xvfb (no other harvest is running now, so bracket-safe pkill is safe here)
pkill -9 -f 'harvest[.]js .*shard[0-9]' 2>/dev/null || true
pkill -9 -f 'worker[-]xvfb' 2>/dev/null || true
for d in 101 102 103 104 105 106; do pkill -9 -f "Xvfb :$d" 2>/dev/null || true; done
sleep 4

# 3) Final idempotent merge (folds sample shard state+ndjson into master).
log "merging sample shards into master..."
./merge-shards.sh 6 harvest.sample.json >> "$LOG" 2>&1 || log "merge returned nonzero (continuing)."

# 4) Clean shard files so the priority run re-seeds all 6 shards from the full master.
rm -f output/harvest_state.s[0-9].json output/harvest_data.s[0-9].ndjson output/harvest_data.s[0-9].csv 2>/dev/null || true
log "cleaned shard files."

# 5) Launch the PRIORITY watchdog (defaults: CFG=harvest.priority.json; TOTAL=6).
TOTAL=6 nohup ./watchdog-priority.sh > /dev/null 2>&1 &
log "launched PRIORITY watchdog (TOTAL=6, pid=$!). Handoff complete."
