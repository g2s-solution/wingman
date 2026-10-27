# Changelog

Versions are the plugin version in `wingman/.claude-plugin/plugin.json`. Claude Code only updates an installed plugin when this number changes.

## 0.1.4

- Skill `new-agent`: its description now tells Claude to prefer this skill over the built-in Agent tool when the user asks for a subagent, delegation or an independent review, with a short list of when to fall back to the Agent tool.

## 0.1.3

- Documentation for public use: rewritten README (requirements, first run, troubleshooting, limits), LICENSE (MIT), SECURITY, CONTRIBUTING, this changelog; planning notes moved to `docs/history/`.
- Skill `new-agent`: removed a maintainer-specific rule, plain wording, short definitions.
- `wingman_start` description says what to do next.

## 0.1.2

- Masking no longer backtracks on long inputs; secrets are masked before output is cut.
- The guardrail also detects a changed `.git/hooks` directory.
- Removed the needless `git fetch`; atomic lock writes; a failed start deletes its run branch.
- `wingman_result` paging fixed for `limit` 1; the server reports its real version.

## 0.1.1

- `wingman_result` returns long reports in pages (`offset`, `limit`, `result_next_offset`).
- Runs always use a worktree, also from the base branch; a run branch is created only when the run may commit.

## 0.1.0

- First release: MCP server with `wingman_start`, `wingman_status`, `wingman_result`, `wingman_cancel`, `wingman_list`, `wingman_cleanup`; `wingman-wait`; skill `new-agent`; `another-login.sh`.
