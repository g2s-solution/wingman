#!/usr/bin/env bash
# PreToolUse: refuse edits to credential and .env files. Exit 2 blocks the call.
f=$(jq -r '.tool_input.file_path // empty')
case ${f##*/} in
  .credentials.json | .env | .env.* | *.pem | *.key)
    echo "Blocked: ${f##*/} may hold secrets; edit it yourself." >&2
    exit 2
    ;;
esac
