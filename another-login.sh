#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--force] [--method claudeai|console|api_key] [config-dir]" >&2
  echo "  config-dir: a bare name (e.g. claude-thinh) becomes ~/.claude-thinh; a value with / or ~ is used as given" >&2
  exit 2
}

SRC_RAW="${CLAUDE_DEFAULT_DIR:-$HOME/.claude}"
# plugins are not shared by default (plugin state is tied to each account).
# To share them, add "plugins" back to the array below.
SHARED=(CLAUDE.md settings.json skills agents commands rules)
KEY_FILE=api-key.env

# realpath -m is missing on macOS/BSD, so fall back to python3
resolve_path() {
  if realpath -m / >/dev/null 2>&1; then
    realpath -m "$1"
  else
    python3 -c 'import os,sys; print(os.path.realpath(os.path.abspath(sys.argv[1])))' "$1"
  fi
}

# A bare name (no /) becomes ~/.<name>; anything else is kept (relative paths resolve from the current directory)
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

SRC="$(resolve_path "${SRC_RAW/#\~/$HOME}")"

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
    *) if [ -z "$dir" ]; then dir="$1"; else usage; fi ;;
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
dir="$(normalize_dir "$dir")"
echo "Using config dir: $dir"

if [ -z "$method" ]; then
  [ -t 0 ] || { echo "no --method given and stdin is not a terminal" >&2; exit 1; }
  echo "Authentication method:"
  echo "  1) claudeai  - Claude subscription (browser login)"
  echo "  2) console   - Anthropic Console account (browser login, API billing)"
  echo "  3) api_key   - Console API key or claude setup-token, no browser login"
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

# Count a profile as logged in only when it actually holds a credential.
# .claude.json appears as soon as claude runs, so it counts only when it contains oauthAccount.
has_login() {
  [ -e "$dir/.credentials.json" ] && return 0
  [ -e "$dir/$KEY_FILE" ] && return 0
  [ -f "$dir/.claude.json" ] && grep -q '"oauthAccount"' "$dir/.claude.json" 2>/dev/null && return 0
  return 1
}
if [ "$force" -eq 0 ] && has_login; then
  echo "refusing: $dir already holds a login; pass --force to reuse it (login replaces the stored account)" >&2
  exit 1
fi

# Keep credentials out of a git repo so an API key or token is not committed by mistake.
if command -v git >/dev/null; then
  p="$dir"
  while [ ! -d "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  if git -C "$p" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
     && ! git -C "$p" check-ignore -q "$dir/$KEY_FILE" 2>/dev/null; then
    if [ "$method" = api_key ]; then
      echo "refusing: $dir is inside a git work tree and not ignored; the API key file could be committed" >&2
      echo "choose a directory outside the repo (e.g. ~/.claude-thinh) or add it to .gitignore" >&2
      exit 1
    else
      echo "warning: $dir is inside a git work tree; do not commit .credentials.json" >&2
    fi
  fi
fi

# Prints "true" or "false"; used to tell the Human if this script changed the default profile's login.
default_logged_in() {
  CLAUDE_CONFIG_DIR="$SRC" claude auth status --json 2>/dev/null \
    | grep -oE '"loggedIn": *(true|false)' | grep -oE '(true|false)' || echo unknown
}
before="$(default_logged_in)"

mkdir -p "$dir"
chmod 700 "$dir"

for f in "${SHARED[@]}"; do
  [ -e "$SRC/$f" ] || continue
  if [ -e "$dir/$f" ] && [ ! -L "$dir/$f" ]; then
    echo "skip $f: a real file or dir already exists in $dir"
    continue
  fi
  ln -sfn "$SRC/$f" "$dir/$f"
  echo "linked $f"
done

# Drop the previous method's credential so --force does not leave the old one taking priority.
case "$method" in
  api_key)
    if [ -e "$dir/.credentials.json" ]; then
      rm -f "$dir/.credentials.json"
      echo "removed old .credentials.json (switching to api_key)"
    fi
    ;;
  *)
    if [ -e "$dir/$KEY_FILE" ]; then
      rm -f "$dir/$KEY_FILE"
      echo "removed old $KEY_FILE (switching to $method)"
    fi
    ;;
esac

echo
echo "Signing in ($method) with CLAUDE_CONFIG_DIR=$dir"
echo "Use the account that this profile should serve, not the default profile's account."

case "$method" in
  claudeai) CLAUDE_CONFIG_DIR="$dir" claude auth login --claudeai ;;
  console)  CLAUDE_CONFIG_DIR="$dir" claude auth login --console ;;
  api_key)
    [ -t 0 ] || { echo "api_key needs a terminal to read the key" >&2; exit 1; }
    read -r -s -p "Credential (sk-ant-api... or sk-ant-oat..., input hidden): " key; echo
    # Sourced later, so reject anything that is not a single token of the Anthropic alphabet.
    [[ "$key" =~ ^sk-ant-[A-Za-z0-9_-]+$ ]] || { echo "that does not look like an Anthropic API key or OAuth token" >&2; exit 1; }
    if [[ "$key" == sk-ant-ort* ]]; then
      echo "that is a refresh token (sk-ant-ort); paste the access token from \`claude setup-token\` (sk-ant-oat) or a Console API key (sk-ant-api)" >&2
      exit 1
    fi
    if [[ "$key" == sk-ant-oat* ]]; then
      # Claude sends ANTHROPIC_API_KEY as x-api-key. An OAuth access token is a Bearer credential and comes back as "Invalid API key".
      var=CLAUDE_CODE_OAUTH_TOKEN
      drop=ANTHROPIC_API_KEY
    else
      var=ANTHROPIC_API_KEY
      drop=CLAUDE_CODE_OAUTH_TOKEN
    fi
    # settings.json is shared with the default profile, so apiKeyHelper cannot be set per profile; the credential lives in a 0600 env file instead.
    # %q because the file is sourced; chmod because the mode of a file that already exists is not changed by umask
    ( umask 077; printf 'unset %s\n%s=%q\n' "$drop" "$var" "$key" > "$dir/$KEY_FILE" )
    chmod 600 "$dir/$KEY_FILE"
    unset key
    echo "stored $var in $dir/$KEY_FILE (0600); load it with: set -a; . $dir/$KEY_FILE; set +a"
    if [ "$var" = CLAUDE_CODE_OAUTH_TOKEN ]; then
      echo "note: setup-token is CLAUDE_CODE_OAUTH_TOKEN. Storing it as ANTHROPIC_API_KEY makes Claude report an invalid API key."
    else
      echo "note: the first claude run may ask you to confirm the API key; choosing Yes is expected."
    fi
    ;;
esac

echo
echo "Account now signed in under $dir:"
if [ "$method" = api_key ]; then
  # shellcheck source=/dev/null
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
  q_dir="$(printf '%q' "$dir")"
  q_key="$(printf '%q' "$dir/$KEY_FILE")"
  cat > "$launcher" <<LAUNCH
#!/usr/bin/env bash
# another-login launcher
export CLAUDE_CONFIG_DIR=$q_dir
if [ -f $q_key ]; then set -a; . $q_key; set +a; fi
# Env files written before oat tokens were recognized stored them in ANTHROPIC_API_KEY.
case \${ANTHROPIC_API_KEY-} in
  sk-ant-oat*)
    if [ -z "\${CLAUDE_CODE_OAUTH_TOKEN-}" ]; then
      export CLAUDE_CODE_OAUTH_TOKEN="\$ANTHROPIC_API_KEY"
    fi
    unset ANTHROPIC_API_KEY
    ;;
esac
exec claude "\$@"
LAUNCH
  chmod +x "$launcher"
  echo "launcher: $launcher  (run \`$name\` to use this profile)"
  case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "note: $bin_dir is not on PATH" ;; esac
  launcher_ok=1
fi

# Register the profile for wingman. The registry holds paths only, never credentials.
if [ "${launcher_ok:-}" = 1 ] && command -v node >/dev/null 2>&1; then
  WM_HOME="${WINGMAN_HOME:-$HOME/.wingman}" WM_ID="${name#claude-}" WM_LABEL="$name" \
    WM_DIR="$dir" WM_CMD="$launcher" node -e '
const fs = require("fs"), path = require("path");
const home = process.env.WM_HOME, file = path.join(home, "accounts.json");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
let reg = { accounts: [] };
if (fs.existsSync(file)) {
  try { reg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { console.error("skip wingman registration: " + file + " is not valid JSON"); process.exit(0); }
}
if (!Array.isArray(reg.accounts)) reg.accounts = [];
const entry = { id: process.env.WM_ID, label: process.env.WM_LABEL, config_dir: process.env.WM_DIR, provider: "claude", command: process.env.WM_CMD };
const i = reg.accounts.findIndex((a) => a.id === entry.id);
const prev = i >= 0 ? reg.accounts[i] : {};
if (i >= 0) reg.accounts[i] = { ...prev, ...entry }; else reg.accounts.push(entry);
const tmp = file + "." + process.pid + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(tmp, file);
console.log("wingman account " + (i >= 0 ? "updated" : "registered") + ": " + entry.id + " (" + file + ")");
'
fi

after="$(default_logged_in)"
if [ "$before" = true ] && [ "$after" != true ]; then
  echo >&2
  echo "WARNING: the default profile ($SRC) was signed in before and is not now. Sign it in again with: claude auth login" >&2
  echo "If you used the same account for both profiles, prefer --method api_key for this one." >&2
fi