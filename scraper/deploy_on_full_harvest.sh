#!/usr/bin/env bash
# Wait for the FULL harvest orchestrator (run-all.sh) to complete, then rebuild the app
# dataset from ALL harvest outputs and push it to origin/main (GitHub Pages deploy).
#
# Trigger: orchestrator.log logs "orchestrator COMPLETE" (run-all.sh finished: broad +
# metadata + full deep harvest + merge/dedup). Resilient: if run-all.sh is no longer
# running but never logged COMPLETE, we keep waiting (its internal watchdog resumes the
# deep run on crash). Idempotent; safe to launch once and forget.
#
# Progress -> output/deploy_full.log. On success writes output/DEPLOY_FULL_DONE.
# Launched by Claude per user instruction: "harvest all remaining data in full... once
# completed we will publish the entire harvested set."
set -uo pipefail
cd "$(dirname "$0")"

ORCH_LOG="output/orchestrator.log"
LOG="output/deploy_full.log"
POLL=120
rm -f output/DEPLOY_FULL_DONE output/DEPLOY_FULL_FAILED

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
done_signal() { tail -n 60 "$ORCH_LOG" 2>/dev/null | grep -q "orchestrator COMPLETE"; }

say "deploy-on-full-harvest watcher armed. waiting for 'orchestrator COMPLETE' in $ORCH_LOG (poll ${POLL}s)."

while ! done_signal; do sleep "$POLL"; done

say "orchestrator COMPLETE detected. Rebuilding app dataset from all harvest outputs..."

build_ok=1
node build_savi_dataset.js >> "$LOG" 2>&1 || build_ok=0
if [ "$build_ok" != "1" ]; then
  say "BUILD FAILED — see log. No push."
  echo "build step failed" > output/DEPLOY_FULL_FAILED
  exit 1
fi

# Sanity: the rebuilt index must not regress below the currently-deployed size.
IND=$(node -e "try{console.log(require('../data/savi_index.json').indicators.length)}catch(e){console.log(0)}")
say "rebuilt savi_index.json: ${IND} indicators"
if [ "${IND:-0}" -lt 1600 ]; then
  say "SANITY FAIL — index has ${IND} (<1600) indicators. No push."
  echo "sanity fail: index=${IND}" > output/DEPLOY_FULL_FAILED
  exit 1
fi

cd ..
git add data/savi_index.json data/values data/geo_counties.geojson data/geo_tracts.geojson 2>>"scraper/$LOG"
if git diff --cached --quiet; then
  say "No data changes to commit (already up to date). Done."
  echo "nothing to commit" > scraper/output/DEPLOY_FULL_DONE
  exit 0
fi

COMMIT_MSG="data: publish FULL harvested dataset (${IND} indicators) — $(date '+%Y-%m-%d %H:%M')"
git commit -m "$COMMIT_MSG" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>" >> "scraper/$LOG" 2>&1

if git push origin main >> "scraper/$LOG" 2>&1; then
  say "PUSHED to origin/main. GitHub Pages will redeploy shortly."
  echo "pushed: ${COMMIT_MSG}" > scraper/output/DEPLOY_FULL_DONE
else
  say "PUSH FAILED — commit created locally; manual push needed."
  echo "push failed (commit created locally)" > scraper/output/DEPLOY_FULL_FAILED
  exit 1
fi
