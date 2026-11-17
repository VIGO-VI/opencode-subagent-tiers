#!/bin/sh
# One command on a fresh machine: fetch this repository if it is not here, run
# the installer, and leave the delegation reminder wired.
set -eu

repo="${TIERS_DIR:-$HOME/Projects/opencode-subagent-tiers}"
remote="${TIERS_REMOTE:-git@github.com:VIGO-VI/opencode-subagent-tiers.git}"

if [ -d "$repo/.git" ]; then
  echo "repo: $repo already here"
  git -C "$repo" fetch --quiet origin || echo "fetch failed, installing the checkout as it is"
else
  echo "repo: cloning $remote"
  mkdir -p "$(dirname "$repo")"
  git clone --quiet "$remote" "$repo"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "WARNING: node 22.6 or newer is not on PATH, so agent models keep whatever they have" >&2
fi
if ! command -v opencode >/dev/null 2>&1 && [ ! -d /Applications/OpenCode.app ]; then
  echo "WARNING: OpenCode was not found, so the model catalog cannot be read yet" >&2
fi

"$repo/install.sh"

echo
echo "The tier router is loaded and the delegation reminder is on."
echo "Change the interval with nudge in $repo/tiers.json, then run this script again."
