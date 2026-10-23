#!/usr/bin/env bash
set -euo pipefail

SRC="${CLAUDE_A_DIR:-$HOME/.claude}"
SHARED=(CLAUDE.md settings.json skills agents commands rules plugins)

dir="${1:-}"
if [ -z "$dir" ]; then
  read -r -p "Config dir for account B [~/.claude-b]: " dir
  dir="${dir:-~/.claude-b}"
fi
dir="${dir/#\~/$HOME}"
dir="$(realpath -m "$dir")"

if [ "$dir" = "$(realpath -m "$SRC")" ]; then
  echo "refusing: $dir is account A's config dir" >&2
  exit 1
fi

mkdir -p "$dir"

for f in "${SHARED[@]}"; do
  [ -e "$SRC/$f" ] || continue
  if [ -e "$dir/$f" ] && [ ! -L "$dir/$f" ]; then
    echo "skip $f: a real file/dir already exists in $dir"
    continue
  fi
  ln -sfn "$SRC/$f" "$dir/$f"
  echo "linked $f"
done

cat <<EOF

Starting claude with CLAUDE_CONFIG_DIR=$dir
  1. run /login and sign in with account B
  2. run /status and check it shows account B
  3. exit (Ctrl+D)
EOF

CLAUDE_CONFIG_DIR="$dir" exec claude
