#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--force] [config-dir]" >&2
  exit 2
}

SRC="$(realpath -m "${CLAUDE_DEFAULT_DIR:-$HOME/.claude}")"
SHARED=(CLAUDE.md settings.json skills agents commands rules plugins)

force=0
dir=""
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$dir" ] && dir="$arg" || usage ;;
  esac
done

command -v claude >/dev/null || { echo "claude is not on PATH" >&2; exit 1; }

if [ -z "$dir" ]; then
  [ -t 0 ] || { echo "no config dir given and stdin is not a terminal" >&2; exit 1; }
  read -r -p "Config dir for the new profile [~/.claude-b]: " dir
  dir="${dir:-~/.claude-b}"
fi
dir="${dir/#\~/$HOME}"
dir="$(realpath -m "$dir")"

# CLAUDE_CONFIG_DIR=$HOME would make Claude Code use $HOME/.claude.json, the default profile's global config.
is_within() { local parent="${2%/}"; [[ "${1%/}/" == "$parent/"* ]]; }
if is_within "$dir" "$SRC" || is_within "$SRC" "$dir"; then
  echo "refusing: $dir is the default profile dir ($SRC), inside it, or one of its parents" >&2
  exit 1
fi

if [ "$force" -eq 0 ] && { [ -e "$dir/.claude.json" ] || [ -e "$dir/.credentials.json" ]; }; then
  echo "refusing: $dir already holds a login; pass --force to reuse it (login replaces the stored account)" >&2
  exit 1
fi

mkdir -p "$dir"

for f in "${SHARED[@]}"; do
  [ -e "$SRC/$f" ] || continue
  if [ -e "$dir/$f" ] && [ ! -L "$dir/$f" ]; then
    echo "skip $f: a real file or dir already exists in $dir"
    continue
  fi
  ln -sfn "$SRC/$f" "$dir/$f"
  echo "linked $f"
done

echo
echo "Signing in with CLAUDE_CONFIG_DIR=$dir"
echo "Use the account that this profile should serve, not the default profile's account."
CLAUDE_CONFIG_DIR="$dir" claude auth login

echo
echo "Account now signed in under $dir:"
CLAUDE_CONFIG_DIR="$dir" claude auth status --text
