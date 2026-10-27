# wingman: design

Delegate work from one Claude Code session (the caller) to another Claude Code account (the target), so the caller can use the target like a subagent but on the target's own quota.

## Concepts

- **Profile**: one Claude account, identified by its config dir (`CLAUDE_CONFIG_DIR`). There is no fixed "A" or "B".
- **Caller**: the profile of the current session, detected from the MCP process's `CLAUDE_CONFIG_DIR` (unset = the default `~/.claude`).
- **Target**: any other profile in the registry. The caller is always excluded from its own targets.
- **Run**: one delegated job, executed by a detached `claude` process under the target profile.

Swapping roles needs no feature: start `claude` under another profile and that profile becomes the caller.

## Account registry

`~/.wingman/accounts.json`. It never holds credentials; login stays in each profile's own config dir. In v0.1 it lists the profiles; the caller names one by `id` or omits it and the server picks one at random among eligible targets (see Account selection). Selection policy, tags and scope arrive in v0.2.

| field | meaning |
|---|---|
| `id`, `label` | short name used by tools and skills |
| `config_dir` | profile directory |
| `provider` | agent backend, default `claude` |
| `command` | executable that starts the agent for this profile, default `claude`; for a profile made by `another-login.sh` it is the launcher (for example `~/.local/bin/claude-thinh`), which sets `CLAUDE_CONFIG_DIR` and loads that profile's credential |
| `scope` | data boundary (for example `company`); a run only goes to an account whose scope matches the work (v0.2) |
| `tags`, `priority` | selection hints (v0.2) |
| `status` | `active`, `disabled`, `rate_limited` (v0.3) |
| `limited_until` | when `rate_limited` ends; expired values count as `active` (v0.3) |

Quota: every run records the `rate_limit_event` data the CLI emits (`status`, `resetsAt`, `rateLimitType`, `utilization`). That is per-run feedback, not a reliable pre-run gauge. The account `status` state machine built on it is v0.3.

## Account selection

v0.1: `account` is optional in `wingman_start`. When omitted, the server picks one at random among the registry targets that are not the caller's profile and not `disabled`. When given, it is used as is.

v0.2 (skill `pick-account`) replaces the random pick with a smarter one:

1. Hard filter: `status = active` and matching `scope`.
2. Match `tags` to the task (heavy implementation, cheap lookup).
3. Order by `priority`, then by fewest recent rate limits.
4. On `rate_limited` mid-run the server reports it; the caller decides to wait or start a new run on another account. The server never reroutes by itself.

## Child process environment

The runner builds the child's environment from an allowlist, never from the caller's environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`/`LC_*`, `TERM`, `SHELL`, `TMPDIR`, the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and their lower-case forms), `CLAUDE_CONFIG_DIR=<target>`, `WINGMAN_DEPTH`. Every `CLAUDE_CODE_*`, `CLAUDECODE` and `ANTHROPIC_*` variable is dropped, because a desktop session sets identity, auth-refresh and messaging variables that would make the child behave as the caller's account or as a desktop child. The child keeps the proxy variables (DLP). **Credentials**: a profile signed in with a token (`another-login.sh`, `authMethod: oauth_token`) authenticates only because its launcher exports `CLAUDE_CODE_OAUTH_TOKEN` from the profile's `api-key.env`; with the credential variables dropped and `CLAUDE_CONFIG_DIR` alone, the child reports "Not logged in" (observed in Gate 0). So the runner execs the account's `command` (the launcher) with the allowlisted env and never reads, stores or forwards a credential itself; the launcher adds it. A profile signed in with `claude auth login` (credentials file in its config dir) works with `command: claude`. Tests: the credential variable is absent from the caller env handed to the runner and appears in the child only through the launcher. The runner's own `git fetch` and `git worktree add` run with the proxy variables removed (`env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy`), with up to 4 retries on a 503, because the internal git host rejects the proxy. Every git command and the setup command runs under a timeout in its own process group, so a timeout kills the whole tree: `git fetch` 120 s per attempt, `git worktree add` 60 s, the setup command 600 s, all overridable. A timeout is a failed start that removes the run directory, the worktree and the lock.

## Run lifecycle

- The MCP server is a stateless control plane. Each run is a detached process (own process group); state lives in `~/.wingman/runs/<id>/` (`meta.json`, `events.jsonl`, `result.md`) so a run outlives the caller session. The child's stdout and stderr go to a file descriptor opened by the runner, never through a pipe to the MCP server, so the child does not get EPIPE when the caller ends.
- Runs are one-shot, like an ordinary subagent: there is no continue or resume. To give more work, start a new run. The runner still pre-assigns a session id (`--session-id <uuid>`) and records it in `meta.json` for diagnostics only.
- **Worktree**: when `cwd` is a repo, the run gets a worktree on a distinct run branch `<caller-branch>-wm-<runid>` cut from the **caller's current feature-branch HEAD** (never from origin/base, so work the caller just committed is present; never the base branch). The caller reviews the run branch and merges or fast-forwards it. The worktree lives under `~/.wingman/worktrees/<runid>`. A per-repo lock, keyed by repo and the optional `lock_key` start parameter, stops two runs from working on the same item.
- **Worktree setup**: a fresh worktree has no dependencies or ignored local config. The setup command comes from the `setup` start parameter or a wingman preset and runs before the task. `.env` files are never copied; checks that need local config are reported as Human items.
- **Run directory**: `meta.json` stores the effective `run_cwd` (the worktree plus the caller's subdirectory offset, computed from real paths, so a symlinked `cwd` works and a path that resolves outside the repo is rejected) and the repo toplevel.
- **Cleanup**: a worktree is removed when its run is accepted or discarded. `wingman_cleanup` refuses `accept` while the worktree has uncommitted changes (`discard` drops them), and refuses while another non-terminal run still references the same worktree. Orphans (terminal runs older than a day, or runs whose supervisor is gone) are pruned at server start, skipping dirty worktrees and worktrees a live run references; only a top-level server (`WINGMAN_DEPTH` 0) prunes, because a child run loads the wingman MCP server too. `events.jsonl` of terminal runs older than 14 days is deleted; the run directory, `meta.json` and `result.md` stay. Cancel kills the process group and checks pid against the recorded start time to avoid pid reuse.
- **Reconcile**: every tool path (status, result, cancel, cleanup, list), `waitForRun` and `wingman-wait` first ends a dead run: `running` with a recorded pid that is dead or whose start time no longer matches, or `running` with no pid recorded more than 20 minutes after creation (the start phase, with fetch, worktree and setup, must fit in it; `WINGMAN_NO_PID_GRACE_MS` overrides), becomes `failed_no_report` and is persisted. `wingman-wait` has no default maximum wait: reconcile ends a dead run, and a hung agent is killed by the run's 4-hour wall-clock limit.
- **Supervisor end**: the supervisor finalizes on the agent's `exit` event plus a 2 s pipe drain, not on `close` (a grandchild holding the pipes would hang the run), then kills what the agent left in its process group. A result received before a timeout kill stands over `timedOut`.
- `wingman-wait <run_id>` blocks until the run ends; run it with Bash `run_in_background` so the caller is woken on exit instead of polling.

### Run status

A run ends in one of: `done`, `partial`, `blocked`, `needs_input`, `needs_caller`, `failed`, `failed_no_report`, `rate_limited`, `cancelled`. The runner appends an instruction that the final message ends with a machine-readable line `WINGMAN_STATUS: done|partial|blocked|needs_input`. A missing line maps to `needs_input`; a child that exits without any result message (for example killed by a DLP block) maps to `failed_no_report`, so `wingman-wait` never hangs. A result that names an explicit `claude plugin install|update|uninstall` command, or says in one sentence with `claude` that a plugin was updated, maps to `needs_caller`. A run that stops at its turn limit (`error_max_turns`) maps to `partial`. A run whose base-branch ref, caller-branch ref or local git config changed while it ran (see Guardrails) maps to `needs_caller` with a note in the result, unless it already failed.

## Tools (MCP server `wingman`)

v0.1: `wingman_start`, `wingman_status`, `wingman_result`, `wingman_cancel`, `wingman_list`, `wingman_cleanup` (accept or discard: removes the worktree and lock, always keeps the run branch). Later: `wingman_accounts`. Start takes optional `account` (random eligible target when omitted), `prompt`, `lock_key`, `setup`, `cwd`, `model`, `preset` or `allowed_tools`, `max_turns`, `worktree`. `allowed_tools` items must match a conservative pattern and may not start with `-`, so an item can never read as a CLI flag. A start is refused when `cwd` is in a git repo whose current branch is a base branch (main, master, the origin HEAD target) or a detached HEAD, whatever `worktree` says.

## Guardrails (in the server, not left to each brief)

- Every run gets an appended system prompt (through `--append-system-prompt`, or `systemPrompt: {type: 'preset', preset: 'claude_code', append}` in the SDK): never print or send sensitive values, never commit to the base branch, do not ask questions (inside a wingman run, "ask the Human" in any rule or skill means: stop and finish with `WINGMAN_STATUS: needs_input`), always end with a final report and the status line.
- No interaction: `--permission-prompts none` where available, `AskUserQuestion` disallowed. Permission denials are recorded and their tool names returned to the caller so it can widen the preset deliberately.
- **Permissions are a preset, not a bare allowlist.** Two presets. `readonly` (default) allows `Read`, `Glob`, `Grep` and read-only git. `edit` allows `Agent`, `Skill`, `Edit`, `Write`, `Read`, `Glob`, `Grep` and `Bash` for git, node, npm and date. `git push` is denied outright in both (pushing stays with the caller), because prefix rules on a push to the base branch are bypassable (`git -C . push`, `env git push`, `sh -c`). The deny list also names `git update-ref`, `git config`, `git remote` and the option-prefix forms `git -C`, `git -c`, `git --no-pager`. **The allow and deny rules are advisory, not a sandbox**: prefix rules are bypassable (`env git push`, `sh -c`), and `Bash(node:*)` (and `Bash(npm:*)` in `edit`) runs arbitrary code, so "denied" means the agent is told no and the permission layer refuses the obvious form, not that the action is impossible. Never `bypassPermissions`. The permission mode (`acceptEdits` versus `auto`, the shared settings default) is decided in Gate 0.
- **Ref snapshot (after-the-fact check)**: before the agent starts, the server hashes `git for-each-ref` of the base branches and the caller branch (never the run branch) and `git config --local --list` into `meta.ref_snapshot`. When the run ends the supervisor recomputes them; a change maps a `done`, `partial`, `blocked` or `needs_input` run to `needs_caller` and appends a guardrail note to the result. It cannot tell the run from the caller committing meanwhile, so the note says to check with git. It detects; it does not prevent.
- **No plugin management in a run**: `Bash(claude:*)`, `Bash(claude plugin:*)` and `Bash(npm install -g:*)` are disallowed. A run must not change the plugin cache under the caller's live session.
- **No recursion in v0.1**: `WINGMAN_DEPTH` (default limit 1) plus the wingman MCP tools disallowed in child runs (`--disallowedTools "mcp__plugin_wingman_*"`) and `--strict-mcp-config` on the child command line, so no MCP server loads in a child run, because the plugin is enabled in every profile through the shared `settings.json`.
- **Output to the caller is masked and capped**: status and result return only the final message and a short status, length-capped, after a secret-pattern mask (bearer, JWT, keys, passwords, URL credentials). Raw `events.jsonl` and tool output are never returned.
- **Files on disk**: `~/.wingman` is mode 0700, files 0600, with retention for `events.jsonl`. The caller skill forbids reading `events.jsonl` and run logs; to review a run it uses `git diff --stat` and a sensitive-word `grep -c` before reading any hunk.

## Packaging

A Claude Code plugin named `wingman`: MCP server declared in the plugin's `.mcp.json`, skills (`new-agent` in v0.1; `pick-account` and `add-account` later), and the helper CLI. Plugin install copies the git tree and runs no build, so the server is committed as a single bundled file (`server/dist/index.js`, esbuild, MCP SDK included) and `.mcp.json` points at `${CLAUDE_PLUGIN_ROOT}/server/dist/index.js`. "Build at install" is not an option. Profiles share the plugin through the symlinked `plugins/` dir and `settings.json` (`enabledPlugins`), so the MCP server is available in every profile without per-profile `claude mcp add`.

## Backends

v0.1 supports Claude Code only, but the runner is written against a small adapter interface: build the command, set the account selector env, inject the guardrail prompt, parse events into a common shape (`started`, `message`, `tool`, `rate_limited`, `finished`), and report the session id. Registry entries have a `provider` field (default `claude`). Other providers (OpenAI Codex, OpenCode, and similar CLIs) are added as further adapters in v0.6; the guardrails and the capped-report rule stay in the server so they apply to every provider.

## Engine

Candidates, to be decided in Gate 0 by testing under a real second profile: the Agent SDK (`query()`; leave `settingSources` unset so user, project and local settings load; `env` replaces the whole environment; `systemPrompt` preset with `append`); `claude -p --output-format stream-json --verbose`; and Claude Code's built-in background sessions (`--bg`, `claude agents --json`, `claude logs`, `claude stop`), which could replace much of the detach, list and cancel code. `--max-turns` works but is hidden from `--help`. `--bare` is not usable (it never reads OAuth). Default if equal: `claude -p` stream-json.

### Gate 0 outcome

- **Engine: `claude -p --output-format stream-json --verbose`** (default, nothing argued for another). Permission mode `acceptEdits`; the `auto` comparison is deferred.
- Verified under the second profile through its launcher, started with `env -i PATH HOME`: `-p` runs, a harmless installed skill expands under `-p`, and this command line is accepted: `-p <prompt> --session-id <uuid> --append-system-prompt <text> --disallowedTools <names...> --permission-mode acceptEdits --permission-prompts none --max-turns <n> --output-format stream-json --verbose`. `--strict-mcp-config` and `--plugin-dir` exist; `--max-turns` is hidden from `--help` but works. The adapter later added `--strict-mcp-config` to the child argv (right after `--verbose`); that exact command line was **not** run against the real CLI. It is unverified and must be confirmed in the main session's real run, including its effect on plugin-provided MCP servers.
- Event contract (keys): `system/init`, `system/hook_started`, `system/hook_response`, `assistant` (`message`, `session_id`, `uuid`), `rate_limit_event` (`rate_limit_info`: `status`, `resetsAt`, `rateLimitType`, `isUsingOverage`, `overageStatus`, `unifiedWindows`; no `utilization` key seen on an idle account), `result/success` (`result`, `is_error`, `num_turns`, `permission_denials`, `stop_reason`, `session_id`, `duration_ms`). The final message is `result.result`.
- **Open (not run in Gate 0)**: spawn from inside a real MCP server (covered by verification step 8.1), `installed_plugins.json` before/after comparison, settings-symlink survival, `--bg`, detached survival after the desktop session ends, `Agent` allow under `-p`.

## Decisions

- **`projects/` is not shared between profiles.** Each profile keeps its own session history. Benefit: no concurrent writes to the same session files and no mixing of transcripts.
- Shared via symlink from the default profile: `CLAUDE.md`, `settings.json`, `skills`, `agents`, `commands`, `rules`, `plugins` (only the ones that exist). Per profile: credentials, `.claude.json`, history, `projects/`.
- User-scope MCP servers (for example redmine, grafana) live in each profile's `.claude.json` and are not shared; add them to a target only if its runs need them.
- Profile identity is checked with `claude auth status --json` (compare account or organization fields and print only same or different), not with file mtimes: the default profile's credentials file changes on every token refresh.
- `CLAUDE_CONFIG_DIR` is not in Anthropic's documented settings, so treat it as working but unsupported.
- Interaction rules in the shared `CLAUDE.md` (ask the Human, open a new session) are redefined for wingman runs by the appended prompt (see Guardrails).

## Risks and checks for Gate 0

- Symlinks can break after a Claude Code update recreates a directory, or if Claude Code rewrites `settings.json` by temp file and rename, which would replace the symlink with a real file and fork settings. Gate 0 changes a setting in the second profile and checks the symlink survives; ship a health check.
- Both profiles write to the shared `plugins/` (`installed_plugins.json`, `known_marketplaces.json`, `synced/`, `data/`) on startup and plugin sync. Gate 0 compares `installed_plugins.json` before and after a second-profile start.
- Updating the plugin while a run is in flight can fail the run.
- Hooks that hard-code `~/.claude` run in every profile; keep hooks path-agnostic.
- Unverified at runtime until Gate 0: whether a plugin skill invoked by name expands under `-p`; whether `rate_limit_event` appears in stream-json; whether plugin stdio MCP servers receive `WINGMAN_DEPTH`; whether `--bg` works under a custom `CLAUDE_CONFIG_DIR`; whether detached children survive the desktop app ending a session; whether the `Agent` tool needs an explicit allow in `-p`; how a worktree path with no plugin install entry resolves project-scope plugins; whether the second profile receives its own `remote-settings.json` proxy (check presence with `ls` only).
