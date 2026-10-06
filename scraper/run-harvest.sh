#!/usr/bin/env bash
# Portable launcher for the SAVI harvester.
# - If the locally-extracted browser libs exist (this dev box), point the loader at them.
# - Pick a display for the headed browser (the create-tables RadWindow needs a real display).
#   On WSL that's WSLg (:0); on a headless Linux server, install xvfb and use `xvfb-run`.
set -euo pipefail
cd "$(dirname "$0")"

NATIVE_LIB="$(pwd)/.native/root/usr/lib/x86_64-linux-gnu"
if [ -d "$NATIVE_LIB" ]; then
  export LD_LIBRARY_PATH="$NATIVE_LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

# Default to WSLg display if none is set.
export DISPLAY="${DISPLAY:-:0}"

echo "DISPLAY=$DISPLAY"
echo "Starting harvest (Ctrl-C is safe — progress is checkpointed to the state file)..."
node harvest.js "$@"
