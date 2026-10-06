#!/usr/bin/env bash
# Run the harvester as N parallel workers, each on its own isolated Xvfb display.
#
#   ./run-parallel.sh [total] [baseConfig]
#     total       number of workers (default 4)
#     baseConfig  base harvest config (default harvest.config.json)
#
# Guarantees NO duplicate harvesting:
#   1. Chunks are partitioned by a stable hash of chunkKey (harvest.js SHARD) -> the N
#      workers' chunk sets are disjoint and together cover every chunk.
#   2. Each worker's state file is SEEDED from the existing master state so chunks already
#      finished by the single-stream run are skipped (no re-hitting the SAVI server for them).
# Each worker appends to its own NDJSON; merge-shards.sh concatenates + dedups at the end.
#
# PRE-FLIGHT: stop any existing single-stream harvester first (run-all.sh / watchdog /
# harvest.js) so you are not running both against the server at once.
set -u

TOTAL="${1:-4}"
BASE="${2:-harvest.config.json}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$HERE" || exit 1

MASTER_STATE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).output.state)' "$BASE")"

echo "[run-parallel] base=$BASE workers=$TOTAL master-state=$MASTER_STATE"

pids=()
for ((i = 0; i < TOTAL; i++)); do
  CFG="$(node make_shard_config.js "$BASE" "$i" "$TOTAL")"
  SSTATE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).output.state)' "$CFG")"
  # Seed this shard's state from the master so already-done work is skipped (avoid duplicates).
  if [[ -f "$MASTER_STATE" && ! -f "$SSTATE" ]]; then
    cp "$MASTER_STATE" "$SSTATE"
    echo "[run-parallel] shard $i: seeded $SSTATE from $MASTER_STATE"
  fi
  DPY=$((101 + i))
  echo "[run-parallel] launching worker $i on :$DPY cfg=$CFG"
  ./worker-xvfb.sh "$CFG" "$DPY" >"output/worker_${i}.log" 2>&1 &
  pids+=($!)
  sleep 2   # stagger starts so displays/sockets settle
done

echo "[run-parallel] ${#pids[@]} workers running (pids: ${pids[*]}). Logs: output/worker_*.log"
fail=0
for p in "${pids[@]}"; do wait "$p" || fail=1; done

echo "[run-parallel] all workers exited (fail=$fail). Merging shards..."
./merge-shards.sh "$TOTAL" "$BASE"
echo "[run-parallel] COMPLETE"
