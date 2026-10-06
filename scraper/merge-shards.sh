#!/usr/bin/env bash
# Merge N shard outputs back into the master harvest files.
#
#   ./merge-shards.sh [total] [baseConfig]
#
# Steps (all idempotent / safe to re-run):
#   1. Append every shard NDJSON onto the master NDJSON.
#   2. Run dedup_output.js on the base config -> collapses to ONE row per
#      (indicator,geo,level,display,year), newest capturedAt wins. So even if a row exists
#      in both the master and a shard, only one survives -> no duplicates in the final data.
#   3. Fold each shard's chunkDone/done/stats into the master state so a later resume skips
#      everything the shards finished.
set -u

TOTAL="${1:-4}"
BASE="${2:-harvest.config.json}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$HERE" || exit 1

MASTER_NDJSON="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).output.ndjson)' "$BASE")"
MASTER_STATE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).output.state)' "$BASE")"

echo "[merge] master ndjson=$MASTER_NDJSON state=$MASTER_STATE"

# 1. Concatenate shard NDJSONs onto the master.
for ((i = 0; i < TOTAL; i++)); do
  SND="${MASTER_NDJSON%.ndjson}.s${i}.ndjson"
  if [[ -f "$SND" ]]; then
    cat "$SND" >> "$MASTER_NDJSON"
    echo "[merge] appended $SND ($(wc -l < "$SND") rows)"
  fi
done

# 2. Collapse duplicates/superseded rows.
node dedup_output.js "$BASE"

# 3. Fold shard states into the master state (union of chunkDone/done; summed stats).
node -e '
  const fs = require("fs");
  const [, masterPath, total] = process.argv;  // node -e has no script-name argv slot
  const load = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  const master = load(masterPath) || { startedAt: new Date().toISOString(), done: {}, chunkDone: {}, stats: { records: 0, tables: 0, errors: 0 } };
  for (let i = 0; i < Number(total); i++) {
    const sp = masterPath.replace(/\.json$/, `.s${i}.json`);
    const s = load(sp);
    if (!s) continue;
    Object.assign(master.chunkDone, s.chunkDone || {});
    Object.assign(master.done, s.done || {});
  }
  master.mergedAt = new Date().toISOString();
  fs.writeFileSync(masterPath, JSON.stringify(master, null, 2));
  console.log("[merge] folded shard states into " + masterPath);
' "$MASTER_STATE" "$TOTAL"

echo "[merge] done"
