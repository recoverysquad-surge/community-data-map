#!/usr/bin/env bash
# Wait until the handoff has COMPLETED (sample fully merged into master), then run the
# sample coverage report. Polls handoff.log for the "Handoff complete" marker written by
# handoff_to_priority.sh step 5. Only then is master NDJSON guaranteed to contain the
# sample's novel-geo-level rows, so the report is accurate (not premature).
set -uo pipefail
cd "$(dirname "$0")"
LOG="output/handoff.log"
OUT="output/sample_results.txt"

# Count "Handoff complete" markers. grep -c already prints 0 when none match (and exits 1,
# which is fine under set +e); the ${x:-0} guards a missing file. NO `|| echo 0` — that would
# append a second line ("0\n0") and break the -gt integer test.
count_done() { local n; n="$(grep -c 'Handoff complete' "$LOG" 2>/dev/null)"; echo "${n:-0}"; }

# Snapshot the current count so we only react to a NEW completion.
base="$(count_done)"

while true; do
  now="$(count_done)"
  if [ "$now" -gt "$base" ]; then break; fi
  sleep 30
done

# Give the merge a moment to fully flush, then report.
sleep 5
echo "=== sample complete — generating report ($(date '+%F %T')) ===" > "$OUT"
node report_sample.js >> "$OUT" 2>&1
echo "REPORT_READY"
