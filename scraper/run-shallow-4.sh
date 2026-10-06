#!/usr/bin/env bash
# Launch the 4 shallow shard workers in parallel (one disjoint category-set each).
# Each worker reads its own harvest.shallow.sN.json -> own output/state files, so they
# never clobber each other and (because categories are disjoint + state is seeded from the
# single-run snapshot) never re-harvest a data item. Ctrl-C is safe: each worker checkpoints
# its state per cell. Logs: output/shallow_sN.log. PIDs: output/shallow_shards.pids.
set -euo pipefail
cd "$(dirname "$0")"

NATIVE_LIB="$(pwd)/.native/root/usr/lib/x86_64-linux-gnu"
if [ -d "$NATIVE_LIB" ]; then
  export LD_LIBRARY_PATH="$NATIVE_LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export DISPLAY="${DISPLAY:-:0}"

echo "DISPLAY=$DISPLAY"
: > output/shallow_shards.pids
for id in s1 s2 s3 s4; do
  cfg="harvest.shallow.${id}.json"
  log="output/shallow_${id}.log"
  echo "launching ${id}  (${cfg})  -> ${log}"
  nohup node harvest.js "$cfg" > "$log" 2>&1 &
  echo "$id $!" >> output/shallow_shards.pids
  sleep 8   # stagger starts so 4 browsers don't hit the server in the same instant
done
echo
echo "4 shard workers launched. PIDs:"
cat output/shallow_shards.pids
echo
echo "Monitor:   tail -f output/shallow_s1.log   (or s2/s3/s4)"
echo "Stop all:  awk '{print \$2}' output/shallow_shards.pids | xargs -r kill -INT   (safe; checkpointed)"
echo "When all 4 finish:  node merge_shallow.js   (merges + dedups into shallow_data.*)"
