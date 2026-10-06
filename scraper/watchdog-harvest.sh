#!/usr/bin/env bash
# Watchdog: keep the SAVI harvester alive until it finishes the FULL run.
# - Never starts a second harvester if one is already running.
# - If the harvester dies before logging "DONE.", relaunch it (resume mode
#   skips every completed cell/chunk, so it safely continues where it left off).
# - Stops once a run logs "DONE." (full catalog scope harvested).
set -uo pipefail
cd "$(dirname "$0")"

CFG="${1:-harvest.config.json}"
RUN_LOG="${2:-output/harvest_run.log}"
WD_LOG="${3:-output/watchdog.log}"
POLL=30          # seconds between liveness checks while running
RESTART_WAIT=15  # seconds to pause before relaunching after a crash
STALL_SECS="${STALL_SECS:-900}"  # if the run log hasn't grown in this long, treat as a stall

wlog() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$WD_LOG"; }

harvester_pid() { pgrep -f "node harvest.js" | head -1; }
is_done() { tail -n 40 "$RUN_LOG" 2>/dev/null | grep -qE "(^|\] )DONE\."; }
# Seconds since the run log was last written to (stall = no output for a while).
log_age() {
  local m now
  m="$(stat -c %Y "$RUN_LOG" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  echo $(( now - m ))
}

wlog "watchdog started (cfg=$CFG, pid=$$, stall=${STALL_SECS}s)."

while true; do
  if is_done; then
    wlog "harvester logged DONE — full run complete. Watchdog exiting."
    break
  fi

  pid="$(harvester_pid)"
  if [ -n "$pid" ]; then
    # Harvester alive — but is it actually making progress? A hung browser/popup
    # leaves the process up while the log goes quiet. If the log hasn't grown in
    # STALL_SECS, kill it so the next loop relaunches (resume skips done work).
    age="$(log_age)"
    if [ "$age" -ge "$STALL_SECS" ]; then
      wlog "harvester STALLED (no log output for ${age}s >= ${STALL_SECS}s) — killing pid $pid to force a resume."
      kill "$pid" 2>/dev/null
      sleep 5
      kill -9 "$pid" 2>/dev/null
      sleep 3
      continue
    fi
    sleep "$POLL"
    continue
  fi

  # Not running and not DONE => it crashed/stopped early. Relaunch (resume).
  if is_done; then
    wlog "harvester finished (DONE) between checks. Watchdog exiting."
    break
  fi
  wlog "harvester not running and not DONE — relaunching in ${RESTART_WAIT}s (resume)."
  sleep "$RESTART_WAIT"
  wlog "relaunching: ./run-harvest.sh $CFG"
  ./run-harvest.sh "$CFG" >> "$RUN_LOG" 2>&1 &
  sleep 10  # give it a moment to spin up before the next liveness poll
done
