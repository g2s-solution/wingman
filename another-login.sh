#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--force] [--method claudeai|console|api_key] [config-dir]" >&2
  exit 2
}

SRC="$(realpath -m "${CLAUDE_DEFAULT_DIR:-$HOME/.claude}")"
SHARED=(CLAUDE.md settings.json skills agents commands rules plugins)
KEY_FILE=api-key.env

force=0
method=""
dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --method) shift; [ $# -gt 0 ] || usage; method="$1" ;;
    --method=*) method="${1#--method=}" ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$dir" ] && dir="$1" || usage ;;
  esac
  shift
done

case "$method" in claudeai|console|api_key|"") ;; *) usage ;; esac

command -v claude >/dev/null || { echo "claude is not on PATH" >&2; exit 1; }

if [ -z "$dir" ]; then
  [ -t 0 ] || { echo "no config dir given and stdin is not a terminal" >&2; exit 1; }
  read -r -p "Config dir for the new profile [~/.claude-b]: " dir
  dir="${dir:-~/.claude-b}"
fi
dir="${dir/#\~/$HOME}"
dir="$(realpath -m "$dir")"

if [ -z "$method" ]; then
  [ -t 0 ] || { echo "no --method given and stdin is not a terminal" >&2; exit 1; }
  echo "Authentication method:"
  echo "  1) claudeai  - Claude subscription (browser login)"
  echo "  2) console   - Anthropic Console account (browser login, API billing)"
  echo "  3) api_key   - API key (ANTHROPIC_API_KEY), no browser login"
  read -r -p "Choose [1]: " choice
  case "${choice:-1}" in
    1) method=claudeai ;;
    2) method=console ;;
    3) method=api_key ;;
    *) echo "invalid choice: $choice" >&2; exit 2 ;;
  esac
fi

# CLAUDE_CONFIG_DIR=$HOME would make Claude Code use $HOME/.claude.json, the default profile's global config.
is_within() { local parent="${2%/}"; [[ "${1%/}/" == "$parent/"* ]]; }
if is_within "$dir" "$SRC" || is_within "$SRC" "$dir"; then
  echo "refusing: $dir is the default profile dir ($SRC), inside it, or one of its parents" >&2
  exit 1
fi

if [ "$force" -eq 0 ] && { [ -e "$dir/.claude.json" ] || [ -e "$dir/.credentials.json" ] || [ -e "$dir/$KEY_FILE" ]; }; then
  echo "refusing: $dir already holds a login; pass --force to reuse it (login replaces the stored account)" >&2
  exit 1
fi

# Prints "true" or "false"; used to tell the Human if this script changed the default profile's login.
default_logged_in() {
  CLAUDE_CONFIG_DIR="$SRC" claude auth status --json 2>/dev/null \
    | grep -oE '"loggedIn": *(true|false)' | grep -oE '(true|false)' || echo unknown
}
before="$(default_logged_in)"

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
echo "Signing in ($method) with CLAUDE_CONFIG_DIR=$dir"
echo "Use the account that this profile should serve, not the default profile's account."

case "$method" in
  claudeai) CLAUDE_CONFIG_DIR="$dir" claude auth login --claudeai ;;
  console)  CLAUDE_CONFIG_DIR="$dir" claude auth login --console ;;
  api_key)
    [ -t 0 ] || { echo "api_key needs a terminal to read the key" >&2; exit 1; }
    read -r -s -p "ANTHROPIC_API_KEY (input hidden): " key; echo
    [[ "$key" == sk-ant-* && "$key" != *[[:space:]]* ]] || { echo "that does not look like an Anthropic API key" >&2; exit 1; }
    # settings.json is shared with the default profile, so apiKeyHelper cannot be set per profile; the key lives in a 0600 env file instead.
    ( umask 077; printf 'ANTHROPIC_API_KEY=%s\n' "$key" > "$dir/$KEY_FILE" )
    unset key
    echo "stored the key in $dir/$KEY_FILE (0600); load it with: set -a; . $dir/$KEY_FILE; set +a"
    ;;
esac

echo
echo "Account now signed in under $dir:"
if [ "$method" = api_key ]; then
  ( set -a; . "$dir/$KEY_FILE"; set +a; CLAUDE_CONFIG_DIR="$dir" claude auth status --text )
else
  CLAUDE_CONFIG_DIR="$dir" claude auth status --text
fi

bin_dir="${LAUNCHER_DIR:-$HOME/.local/bin}"
name="$(basename "$dir")"; name="${name#.}"
launcher="$bin_dir/$name"
if [ -e "$launcher" ] && ! grep -q "^# another-login launcher" "$launcher" 2>/dev/null; then
  echo "skip launcher: $launcher exists and was not made by this script"
else
  mkdir -p "$bin_dir"
  cat > "$launcher" <<LAUNCH
#!/usr/bin/env bash
# another-login launcher
export CLAUDE_CONFIG_DIR='$dir'
if [ -f '$dir/$KEY_FILE' ]; then set -a; . '$dir/$KEY_FILE'; set +a; fi
exec claude "\$@"
LAUNCH
  chmod +x "$launcher"
  echo "launcher: $launcher  (run \`$name\` to use this profile)"
  case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "note: $bin_dir is not on PATH" ;; esac
fi

after="$(default_logged_in)"
if [ "$before" = true ] && [ "$after" != true ]; then
  echo >&2
  echo "WARNING: the default profile ($SRC) was signed in before and is not now. Sign it in again with: claude auth login" >&2
  echo "If you used the same account for both profiles, prefer --method api_key for this one." >&2
fi
