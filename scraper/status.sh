#!/usr/bin/env bash
# Live status dashboard for the prioritized SAVI harvest.
#
#   ./status.sh            # one-shot snapshot
#   ./status.sh -w         # auto-refresh every REFRESH seconds (default 15)
#   REFRESH=5 ./status.sh -w
#
# Shows process health, data progress (via monitor.js), 60s row throughput, and what each
# worker is currently harvesting. Read-only — safe to run while harvesting.
set -uo pipefail
cd "$(dirname "$0")"

CFG="${CFG:-harvest.priority.json}"
TOTAL="${TOTAL:-6}"
REFRESH="${REFRESH:-10}"   # seconds between repaints
SAMPLE="${SAMPLE:-10}"     # seconds to sample row throughput (shorter = snappier live view)
FEED_LINES="${FEED_LINES:-10}"   # how many recent request->response events to show

# Count real processes (exclude this script's own shell match via the pgrep arg trick [x]).
nproc_match() { pgrep -fc "$1" 2>/dev/null || echo 0; }
alive() { pgrep -f "$1" >/dev/null 2>&1 && echo "UP  " || echo "DOWN"; }

# Rotating heartbeat char (time-based so it still spins across watch-mode subshells).
spinner() { local f='|/-\'; printf '%s' "${f:$(( $(date +%s) % 4 )):1}"; }

# Merged live feed: newest timestamped log events across all workers, compacted.
# Each worker line is one request->response: "[t] [Display / Year] N geos x M items -> K records"
# (or "... no grid captured" = an empty response). Tagged with worker id, sorted by time.
feed() {
  local i
  for i in $(seq 0 $((TOTAL-1))); do
    tail -n 15 "output/worker_${i}.log" 2>/dev/null \
      | grep -E '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' \
      | sed "s/^/w${i} /"
  done \
  | sort -k2,2 \
  | tail -n "$FEED_LINES" \
  | sed -E \
      -e 's/^(w[0-9]) \[([0-9:]+)\][[:space:]]+\[([^]]*)\].*-> ([0-9]+) records.*/\1 \2  \3  -> \4 rec/' \
      -e 's/^(w[0-9]) \[([0-9:]+)\][[:space:]]+\[([^]]*)\] no grid.*/\1 \2  \3  (empty)/' \
      -e 's/^(w[0-9]) \[([0-9:]+)\][[:space:]]+(.*)/\1 \2  \3/'
}

snapshot() {
  local orch wd dep workers
  orch="$(alive 'run-parallel.sh '"$TOTAL"' '"$CFG")"
  wd="$(alive 'watchdog-priority.sh')"
  dep="$(alive 'refresh_and_deploy.sh')"
  # real node workers = one per shard config (exclude the worker-xvfb bash wrappers whose
  # command text merely contains the string 'node harvest.js')
  workers="$(pgrep -af 'node harvest.js' | grep -cE 'node harvest\.js /.*harvest\.shard[0-9]')"

  echo "  PROCESSES"
  echo "   orchestrator(run-parallel): $orch     watchdog: $wd     deploy-loop: $dep"
  echo "   shard workers running: $workers / $TOTAL"

  # throughput across shard NDJSONs, sampled over SAMPLE seconds and scaled to rows/min
  local r1 r2 delta rate
  r1=0; for i in $(seq 0 $((TOTAL-1))); do f="output/harvest_data.s${i}.ndjson"; [ -f "$f" ] && r1=$((r1 + $(wc -l < "$f"))); done
  sleep "$SAMPLE"
  r2=0; for i in $(seq 0 $((TOTAL-1))); do f="output/harvest_data.s${i}.ndjson"; [ -f "$f" ] && r2=$((r2 + $(wc -l < "$f"))); done
  delta=$((r2 - r1)); rate=$(( delta * 60 / SAMPLE ))
  echo "   throughput: ~${rate} rows/min  (+${delta} in ${SAMPLE}s; total shard rows: $r2)"

  # data progress
  node monitor.js "$CFG" "$TOTAL"

  echo "  CURRENT WORK (where each worker is)"
  for i in $(seq 0 $((TOTAL-1))); do
    local pos
    pos="$(tail -n 200 "output/worker_${i}.log" 2>/dev/null | grep -E '^===' | tail -1)"
    printf '   w%s: %s\n' "$i" "${pos:-?}"
  done

  echo ""
  echo "  LIVE ACTIVITY  $(spinner)  (requests -> responses, newest at bottom)"
  feed | sed 's/^/   /'
  echo ""
  echo "   (watchdog log: output/watchdog_priority.log | deploy log: output/deploy_loop.log)"
}

if [ "${1:-}" = "-w" ] || [ "${1:-}" = "--watch" ]; then
  # Use the terminal's ALTERNATE screen buffer (like top/htop/less): the dashboard gets
  # its own screen that we fully clear on every refresh, so nothing accumulates in the
  # scrollback and it can't "scroll forever". The original terminal is restored on exit.
  printf '\e[?1049h\e[?25l'                  # enter alt screen, hide cursor
  trap 'printf "\e[?25h\e[?1049l"' EXIT      # show cursor + leave alt screen on exit
  trap 'exit 0' INT TERM                     # Ctrl-C / kill -> exit (fires EXIT trap)
  while true; do
    # Build the whole frame first (snapshot() sleeps SAMPLE secs while sampling) so the
    # previous frame stays put during the sample, then clear + repaint from the top.
    frame="$(snapshot; printf '   refreshing every %ss — Ctrl-C to stop.' "$REFRESH")"
    # Trim to the terminal height so an over-tall frame never scrolls the TOP (the PROCESSES
    # section, with the live worker count) off the alt-screen. Overflow is dropped from the
    # BOTTOM (the live-activity feed) instead — the top stays pinned and always visible.
    rows="$(tput lines 2>/dev/null || echo 50)"
    printf '\e[2J\e[H'                        # clear whole screen + home
    printf '%s\n' "$frame" | head -n "$((rows - 1))"
    sleep "$REFRESH"
  done
else
  snapshot
fi
