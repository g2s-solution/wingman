# wingman: design

Delegate work from one Claude Code session (the caller) to another Claude Code account (the target), so the caller can use the target like a subagent but on the target's own quota.

## Concepts

- **Profile**: one Claude account, identified by its config dir (`CLAUDE_CONFIG_DIR`). There is no fixed "A" or "B".
- **Caller**: the profile of the current session, detected from the MCP process's `CLAUDE_CONFIG_DIR` (unset = the default `~/.claude`).
- **Target**: any other active profile. The caller is always excluded from its own targets.
- **Run**: one delegated job, executed by a detached `claude` process under the target profile.

Swapping roles needs no feature: start `claude` under another profile and that profile becomes the caller.

## Account registry

`~/.wingman/accounts.json`. It never holds credentials; login stays in each profile's own config dir.

| field | meaning |
|---|---|
| `id`, `label` | short name used by tools and skills |
| `config_dir` | profile directory |
| `scope` | data boundary (for example `company`); a run only goes to an account whose scope matches the work |
| `tags` | hints such as `heavy`, `cheap` |
| `priority` | tie-breaker |
| `status` | `active`, `disabled`, `rate_limited` |
| `limited_until` | when `rate_limited` ends; expired values count as `active` |

Quota is a signal, not a gauge: a run that hits a rate limit marks the account `rate_limited` (with the reset time when it can be read); the user can also mark, disable and enable by hand.

## Account selection (skill `pick-account`)

1. Hard filter: `status = active` and matching `scope`.
2. Match `tags` to the task (heavy implementation, cheap lookup).
3. Order by `priority`, then by fewest recent rate limits.
4. On `rate_limited` mid-run the server reports it; the caller decides to wait or start a new run on another account. The server never reroutes by itself.

## Run lifecycle

- The MCP server is a stateless control plane. Each run is a detached process; state lives in `~/.wingman/runs/<id>/` (`meta.json`, `events.jsonl`, `result.md`) so a run outlives the caller session.
- One git worktree and feature branch per run when `cwd` is a repo; never the base branch.
- `wingman-wait <run_id>` blocks until the run ends; run it with Bash `run_in_background` so the caller is woken on exit instead of polling.
- Continuing a run (`wingman_send`) always goes back to the account that ran it (see Decisions).

## Backends

v0.1 supports Claude Code only, but the runner is written against a small adapter interface: build the command, set the account selector env, inject the guardrail prompt, parse events into a common shape (`started`, `message`, `tool`, `rate_limited`, `finished`), and report the session id for resume. Registry entries gain a `provider` field (default `claude`). Other providers (OpenAI Codex, OpenCode, and similar CLIs) are added as further adapters in v0.6; the guardrails and the capped-report rule stay in the server so they apply to every provider.

## Tools (MCP server `wingman`)

`wingman_start`, `wingman_status`, `wingman_result`, `wingman_send`, `wingman_cancel`, `wingman_list`, `wingman_accounts`. Start takes `account` (optional; otherwise `pick-account` rules), `prompt`, `cwd`, `model`, `allowed_tools`, `max_turns`, `worktree`.

## Guardrails (in the server, not left to each brief)

- Every run gets an appended system prompt: never print or send sensitive values, never commit to the base branch, do not ask questions (on a blocker, stop and write it in the report), always end with a final report.
- `status` and `result` return only the final message and a short status, length-capped. Raw `events.jsonl` and tool output are never returned to the caller.
- Permission mode `acceptEdits` plus a narrow `allowedTools`; no bypass. Deny `git push` to the base branch and force pushes.
- `WINGMAN_DEPTH` env var limits delegation depth (default 1: a target does not delegate further).

## Packaging

A Claude Code plugin named `wingman`: MCP server declared in the plugin's `.mcp.json`, skills (`delegate-apply`, `pick-account`, `add-account`), and the helper CLI. Profiles share the plugin through the symlinked `plugins/` dir, so the MCP server is available in every profile without per-profile `claude mcp add`.

## Decisions

- **`projects/` is not shared between profiles.** Each profile keeps its own session history. Cost: a run can only be continued on its own account. Benefit: no concurrent writes to the same session files and no mixing of transcripts. Revisit if cross-account resume proves necessary.
- Shared via symlink from the canonical profile: `CLAUDE.md`, `settings.json`, `skills`, `agents`, `commands`, `rules`, `plugins`. Per profile: credentials, `.claude.json`, history, `projects/`.
- User-scope MCP servers (for example redmine, grafana) live in each profile's `.claude.json` and are not shared; add them to a target only if its runs need them.
- Engine: Agent SDK or `claude -p --output-format stream-json`; choose after testing both under a real second profile.
- `CLAUDE_CONFIG_DIR` is not in Anthropic's documented settings, so treat it as working but unsupported.

## Risks

- Symlinks can break after a Claude Code update recreates a directory; ship a health check.
- Updating the plugin while a run is in flight can fail the run.
- Hooks that hard-code `~/.claude` run in every profile and may cross-contaminate; keep hooks path-agnostic.
