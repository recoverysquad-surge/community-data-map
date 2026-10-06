#!/usr/bin/env bash
# Supervisor for the PRIORITIZED 4-shard SAVI harvest (harvest.priority.json).
#
#   ./watchdog-priority.sh
#
# Keeps `run-parallel.sh 4 harvest.priority.json` alive until the prioritized scope is fully
# harvested, with NO duplicate scraping (resume skips chunkDone; dedup at merge is the backstop):
#   - If neither run-parallel nor any node worker is running -> relaunch run-parallel.
#   - PER-WORKER stall guard: each running shard has a heartbeat = freshest mtime of its
#     worker_<i>.log or harvest_data.s<i>.ndjson. If ANY still-running shard's heartbeat is
#     older than STALL_SECS, kill ALL node workers so the orchestrator finishes (merge) and
#     exits; next loop relaunches it (resume continues). (run-parallel waits on all 4 wrappers
#     then merges+exits with no per-worker relaunch, so a full cycle is the only clean recovery;
#     resume + merge dedup guarantee no duplicate scraping.) A healthy worker can no longer mask
#     a frozen one — the old global max-mtime guard missed exactly that case.
#   - Exits when remaining_chunks.js reports 0 for harvest.priority.json.
# Does NOT touch the deploy loop (refresh_and_deploy.sh) — that runs independently.
set -uo pipefail
cd "$(dirname "$0")"

CFG="${CFG:-harvest.priority.json}"
TOTAL="${TOTAL:-6}"
WD_LOG="${WD_LOG:-output/watchdog_priority.log}"
POLL=60                             # seconds between liveness checks
STALL_SECS="${STALL_SECS:-1200}"    # a running shard with no heartbeat this long => force resume
RESTART_WAIT=15

wlog() { echo "[$(date '+%F %T')] $*" | tee -a "$WD_LOG"; }

orchestrator_up() { pgrep -f "run-parallel.sh $TOTAL $CFG" >/dev/null; }
workers_up()      { pgrep -f "node harvest.js" >/dev/null; }

# Is shard i's node process alive? (match the expanded config path, not the xvfb wrapper text)
shard_alive() { pgrep -f "node harvest\.js .*harvest\.shard${1}\.json" >/dev/null 2>&1; }

# Heartbeat age (secs) for shard i = now - freshest mtime of its worker log OR its shard NDJSON.
# Using the freshest of the two is robust to either file being buffered: a worker churning through
# empty "no grid" responses still updates its log; one producing rows still updates its ndjson.
shard_heartbeat_age() {
  local i="$1" now newest=0 t f
  now="$(date +%s)"
  for f in "output/worker_${i}.log" "output/harvest_data.s${i}.ndjson"; do
    [ -f "$f" ] || continue
    t="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
    [ "$t" -gt "$newest" ] && newest="$t"
  done
  echo $(( now - newest ))
}
remaining() { node remaining_chunks.js "$CFG" "$TOTAL" 2>/dev/null || echo -1; }

wlog "watchdog-priority started (pid=$$, cfg=$CFG, stall=${STALL_SECS}s)."

while true; do
  rem="$(remaining)"
  if [ "$rem" = "0" ]; then
    wlog "prioritized scope COMPLETE (0 chunks remaining). Watchdog exiting."
    break
  fi

  if workers_up; then
    # Workers alive — check EACH running shard's heartbeat independently so one healthy worker
    # can't mask a frozen sibling.
    stalled=""
    for ((i = 0; i < TOTAL; i++)); do
      shard_alive "$i" || continue        # ignore shards that have already finished/exited
      age="$(shard_heartbeat_age "$i")"
      [ "$age" -ge "$STALL_SECS" ] && stalled="$stalled w${i}(${age}s)"
    done
    if [ -n "$stalled" ]; then
      wlog "STALLED workers:$stalled (>= ${STALL_SECS}s), remaining=$rem. Killing ALL workers to force clean resume."
      pkill -9 -f "node harvest.js" 2>/dev/null
      pkill -9 -f "worker-xvfb.sh" 2>/dev/null
      pkill -9 -f "Xvfb :10" 2>/dev/null
      sleep 5
    else
      sleep "$POLL"
    fi
    continue
  fi

  if orchestrator_up; then
    # Orchestrator still finishing (e.g. mid-merge) though no workers — give it a moment.
    sleep "$POLL"; continue
  fi

  wlog "harvest not running (remaining=$rem) — relaunching in ${RESTART_WAIT}s (resume, no dup)."
  sleep "$RESTART_WAIT"
  nohup ./run-parallel.sh "$TOTAL" "$CFG" > output/run_parallel.log 2>&1 &
  wlog "relaunched: run-parallel.sh $TOTAL $CFG"
  sleep 20
done
