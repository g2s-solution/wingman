#!/usr/bin/env bash
# PostToolUse: syntax-check and lint edited shell scripts. Exit 2 feeds stderr back to Claude.
f=$(jq -r '.tool_input.file_path // empty')
[[ $f == *.sh && -f $f ]] || exit 0
out=$(bash -n "$f" 2>&1) || { echo "$out" >&2; exit 2; }
if command -v shellcheck >/dev/null; then
  out=$(shellcheck -f gcc "$f" 2>&1) || { echo "$out" >&2; exit 2; }
fi
