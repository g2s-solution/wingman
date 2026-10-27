#!/usr/bin/env bash
# Local and CI quality gate: format, lint, types, build freshness, tests with coverage >= 80%,
# shell scripts, JSON files and plugin version consistency. Run from anywhere.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
server="$root/wingman/server"
fail=0

step() { printf '\n== %s\n' "$1"; }
note_fail() { printf 'FAIL: %s\n' "$1" >&2; fail=1; }

step "server: install"
if [ -d "$server/node_modules" ] && [ -z "${CI:-}" ]; then
  echo "node_modules present, skipping npm ci"
else
  (cd "$server" && npm ci)
fi

step "server: typecheck, lint, format, build"
(cd "$server" && npm run typecheck && npm run lint && npm run format && npm run build)

step "server: tests with coverage (>= 80%), including the committed-bundle check"
(cd "$server" && npm run coverage)

if [ -n "$(git -C "$root" status --porcelain -- wingman/server/dist)" ]; then
  note_fail "wingman/server/dist/index.js differs from a fresh build; run npm run build and commit it"
fi

step "shell scripts"
scripts=()
while IFS= read -r f; do scripts+=("$f"); done < <(cd "$root" && git ls-files '*.sh')
for f in "${scripts[@]}"; do bash -n "$root/$f" || note_fail "bash -n $f"; done
if command -v shellcheck >/dev/null; then
  (cd "$root" && shellcheck "${scripts[@]}") || note_fail "shellcheck"
elif [ -n "${CI:-}" ]; then
  note_fail "shellcheck is required in CI"
else
  echo "shellcheck not installed, skipped"
fi

step "JSON files"
jsons=()
while IFS= read -r f; do jsons+=("$f"); done < <(cd "$root" && git ls-files '*.json' ':!:**/package-lock.json')
for f in "${jsons[@]}"; do jq -e . "$root/$f" >/dev/null || note_fail "invalid JSON: $f"; done

step "plugin version"
plugin_version=$(jq -r .version "$root/wingman/.claude-plugin/plugin.json")
package_version=$(jq -r .version "$server/package.json")
if [ "$plugin_version" != "$package_version" ]; then
  note_fail "plugin.json ($plugin_version) and server/package.json ($package_version) versions differ"
fi

if [ "$fail" -ne 0 ]; then
  echo; echo "check_quality: FAILED" >&2
  exit 1
fi
echo; echo "check_quality: OK"
