#!/usr/bin/env bash
# One parallel harvest worker on its OWN isolated X display.
#
#   ./worker-xvfb.sh <configPath> <displayNum>
#
# WSLg mounts /tmp/.X11-unix read-only and Xvfb's xkbcomp is pinned to /usr/bin, so a plain
# Xvfb won't start here. We enter a user namespace (where we are root, no real privilege)
# and privately remount what we need:
#   - a writable tmpfs over /tmp/.X11-unix  (so Xvfb can bind its socket)
#   - an overlay over /usr/bin injecting our own xkbcomp (from .native/root)
# then run Xvfb on the given display and the harvester headed against it. Chromium runs as
# namespace-root so SAVI_NO_SANDBOX=1 makes lib/flow.js pass --no-sandbox.
set -u

CFG="${1:?usage: worker-xvfb.sh <configPath> <displayNum>}"
DPY="${2:?usage: worker-xvfb.sh <configPath> <displayNum>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
R="$HERE/.native/root"

rm -f "/tmp/.X${DPY}-lock"

unshare --user --map-root-user --mount bash -c '
  set -u
  R="'"$R"'"; HERE="'"$HERE"'"; DPY="'"$DPY"'"; CFG="'"$CFG"'"
  export LD_LIBRARY_PATH="$R/usr/lib/x86_64-linux-gnu"
  export XKB_CONFIG_ROOT="$R/usr/share/X11/xkb"
  export SAVI_NO_SANDBOX=1

  # private writable socket dir for X
  mount -t tmpfs none /tmp/.X11-unix

  # overlay /usr/bin so Xvfb finds our xkbcomp at its hard-coded path
  mkdir -p "/tmp/ov${DPY}/up" "/tmp/ov${DPY}/work"
  cp "$R/usr/bin/xkbcomp" "/tmp/ov${DPY}/up/xkbcomp" && chmod +x "/tmp/ov${DPY}/up/xkbcomp"
  mount -t overlay overlay -o lowerdir=/usr/bin,upperdir=/tmp/ov${DPY}/up,workdir=/tmp/ov${DPY}/work /usr/bin

  "$R/usr/bin/Xvfb" ":${DPY}" -screen 0 1400x1200x24 -nolisten tcp >"/tmp/xvfb${DPY}.log" 2>&1 &
  XPID=$!
  sleep 3
  export DISPLAY=":${DPY}"

  cd "$HERE"
  node harvest.js "$CFG"
  RC=$?

  kill "$XPID" 2>/dev/null
  exit $RC
'
