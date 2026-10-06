#!/usr/bin/env bash
# Watch the 5 running harvests (sites + 4 shallow shards), auto-resume any that CRASH
# (die without printing "DONE."), and once ALL have cleanly finished: merge -> build the
# app dataset + sites layers -> commit -> push to origin/main (GitHub Pages deploy).
#
# Fully detached & idempotent. Progress -> output/finish_and_deploy.log. On success writes
# output/DEPLOY_DONE; on give-up writes output/DEPLOY_FAILED (and does NOT push partial data).
#
# Launched by Claude per user instruction: "build and push once both harvests finish."
set -uo pipefail
cd "$(dirname "$0")"

NATIVE_LIB="$(pwd)/.native/root/usr/lib/x86_64-linux-gnu"
[ -d "$NATIVE_LIB" ] && export LD_LIBRARY_PATH="$NATIVE_LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DISPLAY="${DISPLAY:-:0}"

LOG=output/finish_and_deploy.log
POLL=60
MAX_RETRIES=10
rm -f output/DEPLOY_DONE output/DEPLOY_FAILED

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# Workers: name | pgrep pattern | log file | resume command
names=(sites s1 s2 s3 s4)
declare -A PAT LOGF CMD RETRY DONE
PAT[sites]="node harvest_sites.js";                 LOGF[sites]=output/sites_points.log;  CMD[sites]="node harvest_sites.js harvest_sites.config.json"
PAT[s1]="node harvest.js harvest.shallow.s1.json";  LOGF[s1]=output/shallow_s1.log;        CMD[s1]="node harvest.js harvest.shallow.s1.json"
PAT[s2]="node harvest.js harvest.shallow.s2.json";  LOGF[s2]=output/shallow_s2.log;        CMD[s2]="node harvest.js harvest.shallow.s2.json"
PAT[s3]="node harvest.js harvest.shallow.s3.json";  LOGF[s3]=output/shallow_s3.log;        CMD[s3]="node harvest.js harvest.shallow.s3.json"
PAT[s4]="node harvest.js harvest.shallow.s4.json";  LOGF[s4]=output/shallow_s4.log;        CMD[s4]="node harvest.js harvest.shallow.s4.json"
for n in "${names[@]}"; do RETRY[$n]=0; DONE[$n]=0; done

alive() { pgrep -f -- "$1" >/dev/null 2>&1; }
finished_clean() { grep -q 'DONE\.' "$1" 2>/dev/null; }

say "watcher armed. waiting for: ${names[*]} (poll ${POLL}s, max ${MAX_RETRIES} resumes each)"

while true; do
  all_done=1
  for n in "${names[@]}"; do
    [ "${DONE[$n]}" = "1" ] && continue
    if alive "${PAT[$n]}"; then
      all_done=0; continue
    fi
    # process not alive -> finished or crashed
    if finished_clean "${LOGF[$n]}"; then
      DONE[$n]=1; say "$n: DONE (clean)."
      continue
    fi
    # crashed: resume if retries remain
    if [ "${RETRY[$n]}" -lt "$MAX_RETRIES" ]; then
      RETRY[$n]=$(( RETRY[$n] + 1 ))
      say "$n: died without DONE -> resume #${RETRY[$n]}"
      setsid bash -c "${CMD[$n]} >> ${LOGF[$n]} 2>&1 < /dev/null" >/dev/null 2>&1 &
      all_done=0
      sleep 10
    else
      say "$n: FAILED after ${MAX_RETRIES} resumes — aborting deploy (no push)."
      echo "aborted: $n never completed" > output/DEPLOY_FAILED
      exit 1
    fi
  done
  [ "$all_done" = "1" ] && break
  sleep "$POLL"
done

say "ALL harvests complete. Building app dataset + sites layers..."

merge_ok=1
node merge_shallow.js      >> "$LOG" 2>&1 || merge_ok=0
node build_savi_dataset.js >> "$LOG" 2>&1 || merge_ok=0
node build_sites_data.js   >> "$LOG" 2>&1 || merge_ok=0
if [ "$merge_ok" != "1" ]; then
  say "BUILD FAILED — see log. No push."
  echo "build step failed" > output/DEPLOY_FAILED
  exit 1
fi

# Sanity: the rebuilt index must not regress below the current deployed size (1011).
IND=$(node -e "try{console.log(require('../data/savi_index.json').indicators.length)}catch(e){console.log(0)}")
say "rebuilt savi_index.json: ${IND} indicators"
if [ "${IND:-0}" -lt 1000 ]; then
  say "SANITY FAIL — index has ${IND} (<1000) indicators. No push."
  echo "sanity fail: index=${IND}" > output/DEPLOY_FAILED
  exit 1
fi

cd ..
git add data/savi_index.json data/values data/geo_counties.geojson data/layers.json data/savi_sites_*.geojson 2>>"scraper/$LOG"
if git diff --cached --quiet; then
  say "No data changes to commit (already up to date). Done."
  echo "nothing to commit" > scraper/output/DEPLOY_DONE
  exit 0
fi

SITES_PTS=$(wc -l < scraper/output/sites_points.ndjson 2>/dev/null | tr -d ' ')
COMMIT_MSG="data: add Sites/asset points (${SITES_PTS}) + refresh harvested dataset (${IND} indicators) — $(date '+%Y-%m-%d %H:%M')"
git commit -m "$COMMIT_MSG" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>" >> "scraper/$LOG" 2>&1

if git push origin main >> "scraper/$LOG" 2>&1; then
  say "PUSHED to origin/main. GitHub Pages will redeploy shortly."
  echo "pushed: ${COMMIT_MSG}" > scraper/output/DEPLOY_DONE
else
  say "PUSH FAILED — commit is created locally; manual push needed."
  echo "push failed (commit created locally)" > scraper/output/DEPLOY_FAILED
  exit 1
fi
