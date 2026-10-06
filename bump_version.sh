#!/usr/bin/env bash
# Bump the ES-module cache-bust version stamp (?v=N) across every web-app file in one shot,
# so a deploy forces browsers to reload the edited modules. Replaces the old error-prone
# hand-editing of ~29 occurrences across 8 files.
#
#   ./bump_version.sh            # auto-increment the current version by 1
#   ./bump_version.sh 120        # set an explicit version
#   ./bump_version.sh --check    # print the current version(s) and exit (no changes)
#
# All files must share ONE version; the script refuses to run if they've drifted apart
# (that drift is itself the bug this tool prevents).
set -euo pipefail
cd "$(dirname "$0")"

FILES=(index.html js/app.js js/charts.js js/layers.js js/metadata.js js/profile.js js/table.js js/ui.js)

# Current distinct versions across all files.
mapfile -t versions < <(grep -rhoE '\?v=[0-9]+' "${FILES[@]}" | sed -E 's/\?v=//' | sort -un)

if [ "${#versions[@]}" -eq 0 ]; then
  echo "bump_version: no ?v=N stamps found — nothing to do." >&2
  exit 1
fi
if [ "${#versions[@]}" -gt 1 ]; then
  echo "bump_version: version drift detected across files: ${versions[*]}" >&2
  echo "  Fix by setting an explicit version: ./bump_version.sh <N>" >&2
  [ "${1:-}" = "--check" ] && exit 0
  # Only allow an explicit set to repair drift; refuse a blind auto-increment.
  [[ "${1:-}" =~ ^[0-9]+$ ]] || exit 1
fi

cur="${versions[-1]}"

if [ "${1:-}" = "--check" ]; then
  echo "current version: v$cur  (across ${#FILES[@]} files)"
  exit 0
fi

if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  next="$1"
else
  next="$((cur + 1))"
fi

count=0
for f in "${FILES[@]}"; do
  n="$(grep -oE '\?v=[0-9]+' "$f" | wc -l)"
  # Match any version so a drifted/explicit set normalizes every file to $next.
  sed -i -E "s/\?v=[0-9]+/?v=$next/g" "$f"
  count=$((count + n))
done
echo "bumped v$cur -> v$next  ($count stamps across ${#FILES[@]} files)"
