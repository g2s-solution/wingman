#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--yes] [--keep-dir] config-dir" >&2
  echo "  Removes a profile made by another-login.sh: wingman registration, launcher and (unless --keep-dir) the profile directory with its credentials." >&2
  echo "  config-dir: a bare name (e.g. claude-second) becomes ~/.claude-second; a value with / or ~ is used as given" >&2
  echo "  Without --yes it asks for confirmation; nothing is changed before that." >&2
  exit 2
}

SRC_RAW="${CLAUDE_DEFAULT_DIR:-$HOME/.claude}"

resolve_path() {
  if realpath -m / >/dev/null 2>&1; then
    realpath -m "$1"
  else
    python3 -c 'import os,sys; print(os.path.realpath(os.path.abspath(sys.argv[1])))' "$1"
  fi
}

normalize_dir() {
  local d="$1"
  d="${d/#\~/$HOME}"
  case "$d" in
    /*|./*|../*|.|..) ;;
    */*) ;;
    *) d="$HOME/.${d#.}" ;;
  esac
  resolve_path "$d"
}

yes=0
keep_dir=0
dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) yes=1 ;;
    --keep-dir) keep_dir=1 ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) if [ -z "$dir" ]; then dir="$1"; else usage; fi ;;
  esac
  shift
done
[ -n "$dir" ] || usage

SRC="$(resolve_path "${SRC_RAW/#\~/$HOME}")"
# resolve_path follows symlinks, so a symlinked profile would delete its target and leave the link behind.
raw="${dir/#\~/$HOME}"
case "$raw" in */*) ;; *) raw="$HOME/.${raw#.}" ;; esac
if [ -L "${raw%/}" ]; then
  echo "refusing: $raw is a symlink; pass the real directory it points to" >&2
  exit 1
fi
dir="$(normalize_dir "$dir")"

# The default profile is the source of the shared items; removing it, a parent or a child would destroy the user's main setup.
is_within() { local parent="${2%/}"; [[ "${1%/}/" == "$parent/"* ]]; }
if [ "$dir" = / ] || is_within "$HOME" "$dir" || is_within "$dir" "$SRC" || is_within "$SRC" "$dir"; then
  echo "refusing: $dir is the default profile dir ($SRC), inside it, one of its parents, or \$HOME or a parent of it" >&2
  exit 1
fi
[ -d "$dir" ] || { echo "no such profile directory: $dir" >&2; exit 1; }

# A real Claude profile has .claude.json or one of this repo's credential files; anything else is not ours to delete.
if [ ! -f "$dir/.claude.json" ] && [ ! -e "$dir/.credentials.json" ] && [ ! -e "$dir/api-key.env" ]; then
  echo "refusing: $dir does not look like a Claude profile (no .claude.json, .credentials.json or api-key.env)" >&2
  exit 1
fi

bin_dir="${LAUNCHER_DIR:-$HOME/.local/bin}"
name="$(basename "$dir")"; name="${name#.}"
launcher="$bin_dir/$name"
wm_id="${name#claude-}"
bundle="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wingman/server/dist/index.js"

have_launcher=0
[ -e "$launcher" ] && grep -q "^# another-login launcher" "$launcher" 2>/dev/null && have_launcher=1

echo "This will remove:"
echo "  - wingman registration '$wm_id' (paths only, no credentials)"
[ "$have_launcher" -eq 1 ] && echo "  - launcher $launcher"
if [ "$keep_dir" -eq 1 ]; then
  echo "  - nothing else: the profile directory $dir is kept"
else
  echo "  - profile directory $dir (credentials, history, sessions; symlinked shared items are unlinked, their targets stay)"
fi

if [ "$yes" -eq 0 ]; then
  [ -t 0 ] || { echo "not a terminal: pass --yes to confirm" >&2; exit 1; }
  read -r -p "Proceed? [y/N] " answer
  case "$answer" in y|Y|yes) ;; *) echo "aborted"; exit 1 ;; esac
fi

if command -v node >/dev/null 2>&1 && [ -f "$bundle" ]; then
  WINGMAN_HOME="${WINGMAN_HOME:-$HOME/.wingman}" node "$bundle" accounts remove "$wm_id" --yes \
    || echo "warning: wingman registration was not removed (not registered?); check with: node $bundle accounts list" >&2
else
  echo "warning: node or $bundle is missing; remove the registration with: wingman accounts remove $wm_id --yes" >&2
fi

if [ "$have_launcher" -eq 1 ]; then
  rm -f "$launcher"
  echo "removed launcher $launcher"
elif [ -e "$launcher" ]; then
  echo "skip launcher: $launcher was not made by another-login.sh"
fi

if [ "$keep_dir" -eq 0 ]; then
  # rm -rf does not follow symlinks, so shared items link back to the default profile are unlinked, never deleted.
  rm -rf -- "$dir"
  echo "removed $dir"
fi
