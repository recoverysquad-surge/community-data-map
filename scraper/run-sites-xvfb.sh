#!/usr/bin/env bash
# Finish the SITES point harvest on its own isolated X display (same namespace+Xvfb recipe
# as worker-xvfb.sh). harvest_sites.js is resumable (groupDone) so this only retries the
# groups not yet marked done (4 errored of 168).
#
#   ./run-sites-xvfb.sh [displayNum=105] [config=harvest_sites.config.json]
set -u

DPY="${1:-105}"
CFG="${2:-harvest_sites.config.json}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
R="$HERE/.native/root"

rm -f "/tmp/.X${DPY}-lock"

unshare --user --map-root-user --mount bash -c '
  set -u
  R="'"$R"'"; HERE="'"$HERE"'"; DPY="'"$DPY"'"; CFG="'"$CFG"'"
  export LD_LIBRARY_PATH="$R/usr/lib/x86_64-linux-gnu"
  export XKB_CONFIG_ROOT="$R/usr/share/X11/xkb"
  export SAVI_NO_SANDBOX=1
  mount -t tmpfs none /tmp/.X11-unix
  mkdir -p "/tmp/ov${DPY}/up" "/tmp/ov${DPY}/work"
  cp "$R/usr/bin/xkbcomp" "/tmp/ov${DPY}/up/xkbcomp" && chmod +x "/tmp/ov${DPY}/up/xkbcomp"
  mount -t overlay overlay -o lowerdir=/usr/bin,upperdir=/tmp/ov${DPY}/up,workdir=/tmp/ov${DPY}/work /usr/bin
  "$R/usr/bin/Xvfb" ":${DPY}" -screen 0 1400x1200x24 -nolisten tcp >"/tmp/xvfb${DPY}.log" 2>&1 &
  XPID=$!
  sleep 3
  export DISPLAY=":${DPY}"
  cd "$HERE"
  node harvest_sites.js "$CFG"
  RC=$?
  kill "$XPID" 2>/dev/null
  exit $RC
'
