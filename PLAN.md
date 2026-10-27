# wingman: implementation plan (Gate 0 to v0.1)

Scope: everything needed for `os-apply` of a small change to run on a second account from the caller session, packaged as an installable plugin. Later phases are in `ROADMAP.md`; decisions, guardrails and the run lifecycle are in `DESIGN.md`.

Rules for every step: no sensitive values read or printed (check files with `grep -c` first, report structure only, print env variable names but never values); work on a feature branch, never the base branch; each step ends with its check passing before the next starts.

## v0.1 scope

In: one target chosen by `id` from the registry; `wingman_start`, `wingman_status`, `wingman_result`, `wingman_send`, `wingman_cancel`, `wingman_list`; env allowlist for the child; worktree cut from the caller's feature branch with setup and cleanup; guardrail prompt and the `WINGMAN_STATUS` line; the `os-apply` permission preset; no-recursion guard (`WINGMAN_DEPTH` plus disallowed wingman tools); masking and capping of everything returned; recording of `rate_limit_event` data on each run; `wingman-wait`; the `delegate-apply` skill; plugin packaging with a bundled server.

Out (later phases): selection policy and `pick-account`, tags, scope, priority, account status machine, CLI subcommands, role-swap testing, queueing, other providers.

## Layout

```
.claude-plugin/marketplace.json   repo root is a marketplace; its one plugin has source ./wingman
.mcp.json, .claude/, CLAUDE.md    repo tooling (context7, hooks), not part of the plugin
another-login.sh, DESIGN.md ROADMAP.md PLAN.md   repo root
wingman/                      plugin root (the repo-root .mcp.json stays separate)
  .claude-plugin/plugin.json
  .mcp.json                   points at ${CLAUDE_PLUGIN_ROOT}/server/dist/index.js
  server/                     TypeScript, Node 22, bundled with esbuild
    src/index.ts              MCP stdio entry, tool handlers
    src/registry.ts           accounts.json read/write
    src/runs.ts               run dirs, meta, event log, masked and capped summaries
    src/runner.ts             detached runner (one per run), adapter interface
    src/adapters/claude.ts    command line, env allowlist, event parsing
    src/worktree.ts           worktree, setup, lock, cleanup
    src/guard.ts              appended prompt, presets, deny lists
    src/self.ts               caller profile detection, depth guard
    src/mask.ts               secret-pattern masking
    test/
    dist/index.js             committed bundle
  bin/wingman-wait            blocks until a run ends
  skills/delegate-apply/SKILL.md
```

## Steps

### 0. Gate 0: verify before building (user logs in, we verify)
1. User runs `./another-login.sh` (it signs in with `claude auth login` and prints the signed-in account).
2. Isolation, without reading credential files: the second profile has its own `.credentials.json` (`ls -la`); `claude auth status --json` under each profile, compared with `jq` on account and organization fields, printing only `same` or `different`. Do not use the default profile's credentials mtime as a test (it changes on every token refresh).
3. `CLAUDE_CONFIG_DIR=<dir> claude -p "reply ok" --output-format json` succeeds.
4. Plugins and skills: `claude plugin list` under the second profile shows `ailab-agent`; a headless call runs a harmless skill (`os-onboard`); `/ailab-agent:os-apply` expands as a skill under `-p`.
5. Real spawn context: spawn the child from inside a real Claude Code session (ideally from a stub MCP server), log env variable names only, and confirm the allowlist env makes the child serve the second account (same `auth status` comparison from the child).
6. Shared state: compare `installed_plugins.json` hash and mtime before and after a second-profile start; change a setting in the second profile and confirm `settings.json` is still a symlink; check with `ls` that the second profile gets its own `remote-settings.json`.
7. Engine comparison on the same trivial prompt: Agent SDK `query()`, `claude -p --output-format stream-json --verbose`, and the built-in background sessions (`--bg`, `claude agents --json`, `claude logs`, `claude stop`). Record what each loads (CLAUDE.md, skills, plugins), how resume works, whether `rate_limit_event` is emitted, how detach and cancel behave, whether detached children survive the desktop app ending a session, and whether the `Agent` tool needs an explicit allow in `-p`. Compare permission modes `acceptEdits` and `auto` for `os-apply`. Pick one engine; default if equal is `claude -p` stream-json.
8. Note for the user: user-scope MCP servers (redmine, grafana) are per profile and will be absent in the target.

Exit: engine, permission mode and env allowlist confirmed and written into `DESIGN.md`; findings listed.

### 1. Scaffold the plugin
- `plugin.json` (name `wingman`), `.mcp.json`, `package.json`, `tsconfig`, vitest, lint and format, an esbuild script that writes `server/dist/index.js`.
- Rename the working dir to `wingman/` (outside the session or at the start of a new one).
- Check: `npm run build` and `npm test` pass on an empty skeleton; the plugin loads with `claude --plugin-dir`; the committed bundle is up to date (a CI or test check compares a fresh build with `dist/`).

### 2. Registry, self-detection, guard of depth (`registry.ts`, `self.ts`)
- `~/.wingman/accounts.json` (mode 0600, directory 0700) with `id`, `label`, `config_dir`, `provider`; read and write atomically.
- Caller profile = realpath of `CLAUDE_CONFIG_DIR` or `~/.claude`; excluded from targets. `WINGMAN_DEPTH` check.
- Tests: self-exclusion, symlinked config dirs resolve to the same profile, a missing file creates an empty registry, depth limit refuses a nested start.

### 3. Run storage and masking (`runs.ts`, `mask.ts`)
- `~/.wingman/runs/<id>/` with `meta.json` (account, cwd, branch, session id, status, timestamps, pid and start time), `events.jsonl` (raw, never returned), `result.md`; files 0600, retention for `events.jsonl`.
- `mask.ts` masks bearer tokens, JWTs, API-key shapes, passwords and URL credentials; `status` and `result` are masked first, then truncated to a fixed size.
- Tests: raw tool output never appears in what the server returns; masking patterns; file modes.

### 4. Runner (`runner.ts`, `adapters/claude.ts`, `guard.ts`, `worktree.ts`)
- Runner talks to an adapter interface (build command, env, guard injection, event parsing, session id); only the Claude adapter exists.
- Detached `spawn` in its own process group, `stdio` as a file fd (not a pipe). Child env from the allowlist in `DESIGN.md`; `WINGMAN_DEPTH` incremented; pre-assigned `--session-id`.
- Appended prompt from `guard.ts` (sensitive values, base branch, no questions, `WINGMAN_STATUS` last line, "ask the Human" means `needs_input`); deny lists and the `os-apply` preset; `--permission-prompts none`; `AskUserQuestion`, plugin management and wingman tools disallowed; `git push` denied.
- Status mapping: `WINGMAN_STATUS` line, missing line to `needs_input`, no result message to `failed_no_report`, plugin update detected to `needs_caller`, rate limit to `rate_limited` with `resetsAt` and `utilization` recorded.
- Worktree: fetch with proxy variables removed (retry up to 4 times on a 503), `git worktree add` on `<caller-branch>-wm-<runid>` from the caller's feature-branch HEAD, refuse the base branch, per-repo and per-change lock, project setup command, cleanup on accept or discard, orphan pruning, cancel kills the process group after checking pid and start time.
- Tests with a fake `claude` binary: normal finish, non-zero exit, timeout, cancel, rate limit, no result message, missing status line, worktree refused on the base branch, env allowlist drops `CLAUDE_CODE_*`, lock prevents a second run on the same change.

### 5. MCP server (`index.ts`)
- Tools: `wingman_start`, `wingman_status`, `wingman_result`, `wingman_send` (same account only, refused for `failed_no_report`), `wingman_cancel`, `wingman_list`.
- Stateless: every call reads run state from disk, so a run survives the caller session.
- Check: MCP inspector call of each tool against the fake binary; then one real trivial run under the second profile.

### 6. `wingman-wait`
- `bin/wingman-wait <run_id>`: poll `meta.json`, exit when the run is in a terminal status, print only the final status line.

### 7. Skill `delegate-apply`
- The caller runs `check-version-plugin.mjs --gate` first, commits the change artifacts on a feature branch, calls `wingman_start` with `/ailab-agent:os-apply <name>` and the `os-apply` preset, starts `wingman-wait` with `run_in_background`, then reads the masked report and the run branch with `git diff --stat` plus a sensitive-word `grep -c` before any hunk. It never reads `events.jsonl` or run logs. Unticked tasks and `Human:` findings go back to the user.
- The skill carries the sensitive-values rule and the English-for-review-comments rule.

### 8. End-to-end verification
1. Trivial prompt on the second account through the MCP server.
2. Detached survival: close the caller session mid-run, reopen, read the result.
3. `os-apply` of a small real change in a throwaway repo: masked and capped report, run branch on the worktree, base branch and caller branch untouched, plugin install untouched.
4. Rate-limit and `failed_no_report` paths with the fake binary.
5. Review: independent reviewer subagent over the whole diff (correctness, security, DLP leakage, env leakage, process and worktree cleanup).

### 9. Packaging
- Committed bundle, `README` with install and login steps, version `0.1.0`; install the plugin into the default profile and confirm the second profile sees it through the shared `plugins/` and `settings.json`.

## Parallelisation

After step 1: steps 2 and 3 are independent (separate files); step 4 needs both; steps 6 and 7 can run in parallel with step 5 once the tool contracts in `DESIGN.md` are fixed. Implementation goes to `sonnet` agents from this plan, review of step 8 to an `opus` agent; Gate 0 and the engine choice stay in the main session.

## Open points

- Engine and permission mode (decided in step 0).
- The per-project setup command format for worktrees (from `openspec/config.yaml` or a preset).
- Name of the plugin marketplace entry and where it is published internally.
