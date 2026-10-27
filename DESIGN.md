# wingman: design

Delegate work from one Claude Code session (the caller) to another Claude Code account (the target), so the caller can use the target like a subagent but on the target's own quota.

## Concepts

- **Profile**: one Claude account, identified by its config dir (`CLAUDE_CONFIG_DIR`). There is no fixed "A" or "B".
- **Caller**: the profile of the current session, detected from the MCP process's `CLAUDE_CONFIG_DIR` (unset = the default `~/.claude`).
- **Target**: any other profile in the registry. The caller is always excluded from its own targets.
- **Run**: one delegated job, executed by a detached `claude` process under the target profile.

Swapping roles needs no feature: start `claude` under another profile and that profile becomes the caller.

## Account registry

`~/.wingman/accounts.json`. It never holds credentials; login stays in each profile's own config dir. In v0.1 it lists the profiles and the caller picks one by `id`; selection policy, tags and scope arrive in v0.2.

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

## Account selection (skill `pick-account`, v0.2)

1. Hard filter: `status = active` and matching `scope`.
2. Match `tags` to the task (heavy implementation, cheap lookup).
3. Order by `priority`, then by fewest recent rate limits.
4. On `rate_limited` mid-run the server reports it; the caller decides to wait or start a new run on another account. The server never reroutes by itself.

## Child process environment

The runner builds the child's environment from an allowlist, never from the caller's environment: `PATH`, `HOME`, `USER`, `LANG`/`LC_*`, `TERM`, `SHELL`, the proxy variables, `CLAUDE_CONFIG_DIR=<target>`, `WINGMAN_DEPTH`. Every `CLAUDE_CODE_*`, `CLAUDECODE` and `ANTHROPIC_*` variable is dropped, because a desktop session sets identity, auth-refresh and messaging variables that would make the child behave as the caller's account or as a desktop child. The child keeps the proxy variables (DLP). **Credentials**: a profile signed in with a token (`another-login.sh`, `authMethod: oauth_token`) authenticates only because its launcher exports `CLAUDE_CODE_OAUTH_TOKEN` from the profile's `api-key.env`; with the credential variables dropped and `CLAUDE_CONFIG_DIR` alone, the child reports "Not logged in" (observed in Gate 0). So the runner execs the account's `command` (the launcher) with the allowlisted env and never reads, stores or forwards a credential itself; the launcher adds it. A profile signed in with `claude auth login` (credentials file in its config dir) works with `command: claude`. Tests: the credential variable is absent from the caller env handed to the runner and appears in the child only through the launcher. The runner's own `git fetch` and `git worktree add` run with the proxy variables removed (`env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy`), with up to 4 retries on a 503, because the internal git host rejects the proxy.

## Run lifecycle

- The MCP server is a stateless control plane. Each run is a detached process (own process group); state lives in `~/.wingman/runs/<id>/` (`meta.json`, `events.jsonl`, `result.md`) so a run outlives the caller session. The child's stdout and stderr go to a file descriptor opened by the runner, never through a pipe to the MCP server, so the child does not get EPIPE when the caller ends.
- The runner pre-assigns the session id (`--session-id <uuid>`) and stores it for `wingman_send`.
- **Worktree**: when `cwd` is a repo, the run gets a worktree on a distinct run branch `<caller-branch>-wm-<runid>` cut from the **caller's current feature-branch HEAD** (never from origin/base, so artifacts the caller just committed, such as an OpenSpec change, are present; never the base branch). The caller reviews the run branch and merges or fast-forwards it. The worktree lives under `~/.wingman/worktrees/<runid>`. A per-repo lock, keyed by repo and change name, stops two runs from applying the same change.
- **Worktree setup**: a fresh worktree has no dependencies or ignored local config. Each project provides a setup command (from `openspec/config.yaml` or a wingman preset) that runs before the task. `.env` files are never copied; checks that need local config are reported as Human items.
- **Cleanup**: a worktree is removed when its run is accepted or discarded; orphans (run finished or pid dead) are pruned. Cancel kills the process group and checks pid against the recorded start time to avoid pid reuse.
- `wingman-wait <run_id>` blocks until the run ends; run it with Bash `run_in_background` so the caller is woken on exit instead of polling.
- Continuing a run (`wingman_send`) always goes back to the account that ran it (see Decisions) and is refused for a run in `failed_no_report` state.

### Run status

A run ends in one of: `done`, `partial`, `blocked`, `needs_input`, `needs_caller`, `failed`, `failed_no_report`, `rate_limited`, `cancelled`. The runner appends an instruction that the final message ends with a machine-readable line `WINGMAN_STATUS: done|partial|blocked|needs_input`. A missing line maps to `needs_input`; a child that exits without any result message (for example killed by a DLP block) maps to `failed_no_report`, so `wingman-wait` never hangs. For apply-style work the runner also compares task ticks before and after the run. A result that reports a plugin update or install maps to `needs_caller`.

## Tools (MCP server `wingman`)

v0.1: `wingman_start`, `wingman_status`, `wingman_result`, `wingman_send`, `wingman_cancel`, `wingman_list`. Later: `wingman_accounts`. Start takes `account`, `prompt`, `cwd`, `model`, `preset` or `allowed_tools`, `max_turns`, `worktree`.

## Guardrails (in the server, not left to each brief)

- Every run gets an appended system prompt (through `--append-system-prompt`, or `systemPrompt: {type: 'preset', preset: 'claude_code', append}` in the SDK): never print or send sensitive values, never commit to the base branch, do not ask questions (inside a wingman run, "ask the Human" in any rule or skill means: stop and finish with `WINGMAN_STATUS: needs_input`), always end with a final report and the status line.
- No interaction: `--permission-prompts none` where available, `AskUserQuestion` disallowed. Permission denials are recorded and their tool names returned to the caller so it can widen the preset deliberately.
- **Permissions are a preset, not a bare allowlist.** The `os-apply` preset allows: `Agent`, `Skill`, `Edit`, `Write`, `Read`, `Bash(git:*)`, `Bash(node:*)`, `Bash(openspec:*)`, `Bash(date:*)` and the project's check commands read from `openspec/config.yaml`. `git push` is denied outright (os-apply never pushes; pushing stays with the caller and `os-mr`), because prefix rules on a push to the base branch are bypassable (`git -C . push`, `env git push`, `sh -c`). Never `bypassPermissions`. The permission mode (`acceptEdits` versus `auto`, the shared settings default) is decided in Gate 0.
- **No plugin management in a run**: `Bash(claude:*)`, `Bash(claude plugin:*)` and `Bash(npm install -g:*)` are disallowed. The caller runs the plugin version gate (`check-version-plugin.mjs --gate`) before delegating, because the plugin's own rules tell a run to self-update on a failed gate, which would change the plugin cache under the caller's live session.
- **No recursion in v0.1**: `WINGMAN_DEPTH` (default limit 1) plus the wingman MCP tools disallowed in child runs (`--disallowedTools "mcp__plugin_wingman_*"` or `--strict-mcp-config`), because the plugin is enabled in every profile through the shared `settings.json`.
- **Output to the caller is masked and capped**: status and result return only the final message and a short status, length-capped, after a secret-pattern mask (bearer, JWT, keys, passwords, URL credentials). Raw `events.jsonl` and tool output are never returned.
- **Files on disk**: `~/.wingman` is mode 0700, files 0600, with retention for `events.jsonl`. The caller skill forbids reading `events.jsonl` and run logs; to review a run it uses `git diff --stat` and a sensitive-word `grep -c` before reading any hunk.

## Packaging

A Claude Code plugin named `wingman`: MCP server declared in the plugin's `.mcp.json`, skills (`delegate-apply` in v0.1; `pick-account` and `add-account` later), and the helper CLI. Plugin install copies the git tree and runs no build, so the server is committed as a single bundled file (`server/dist/index.js`, esbuild, MCP SDK included) and `.mcp.json` points at `${CLAUDE_PLUGIN_ROOT}/server/dist/index.js`. "Build at install" is not an option. Profiles share the plugin through the symlinked `plugins/` dir and `settings.json` (`enabledPlugins`), so the MCP server is available in every profile without per-profile `claude mcp add`.

## Backends

v0.1 supports Claude Code only, but the runner is written against a small adapter interface: build the command, set the account selector env, inject the guardrail prompt, parse events into a common shape (`started`, `message`, `tool`, `rate_limited`, `finished`), and report the session id for resume. Registry entries have a `provider` field (default `claude`). Other providers (OpenAI Codex, OpenCode, and similar CLIs) are added as further adapters in v0.6; the guardrails and the capped-report rule stay in the server so they apply to every provider.

## Engine

Candidates, to be decided in Gate 0 by testing under a real second profile: the Agent SDK (`query()`; leave `settingSources` unset so user, project and local settings load; `env` replaces the whole environment; `systemPrompt` preset with `append`); `claude -p --output-format stream-json --verbose`; and Claude Code's built-in background sessions (`--bg`, `claude agents --json`, `claude logs`, `claude stop`), which could replace much of the detach, list and cancel code. `--max-turns` works but is hidden from `--help`. `--bare` is not usable (it never reads OAuth). Default if equal: `claude -p` stream-json.

### Gate 0 outcome

- **Engine: `claude -p --output-format stream-json --verbose`** (default, nothing argued for another). Permission mode `acceptEdits`; the `auto` comparison is deferred.
- Verified under the second profile through its launcher, started with `env -i PATH HOME`: `-p` runs, `/ailab-agent:os-onboard` expands as a skill under `-p`, and this command line is accepted: `-p <prompt> --session-id <uuid> --append-system-prompt <text> --disallowedTools <names...> --permission-mode acceptEdits --permission-prompts none --max-turns <n> --output-format stream-json --verbose`. `--strict-mcp-config` and `--plugin-dir` exist; `--max-turns` is hidden from `--help` but works.
- Event contract (keys): `system/init`, `system/hook_started`, `system/hook_response`, `assistant` (`message`, `session_id`, `uuid`), `rate_limit_event` (`rate_limit_info`: `status`, `resetsAt`, `rateLimitType`, `isUsingOverage`, `overageStatus`, `unifiedWindows`; no `utilization` key seen on an idle account), `result/success` (`result`, `is_error`, `num_turns`, `permission_denials`, `stop_reason`, `session_id`, `duration_ms`). The final message is `result.result`.
- **Open (not run in Gate 0)**: spawn from inside a real MCP server (covered by verification step 8.1), `installed_plugins.json` before/after comparison, settings-symlink survival, `--bg`, detached survival after the desktop session ends, `Agent` allow under `-p`.

## Decisions

- **`projects/` is not shared between profiles.** Each profile keeps its own session history. Cost: a run can only be continued on its own account. Benefit: no concurrent writes to the same session files and no mixing of transcripts. Revisit if cross-account resume proves necessary.
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
- Unverified at runtime until Gate 0: whether `/ailab-agent:os-apply <name>` expands as a skill under `-p`; whether `rate_limit_event` appears in stream-json; whether plugin stdio MCP servers receive `WINGMAN_DEPTH`; whether `--bg` works under a custom `CLAUDE_CONFIG_DIR`; whether detached children survive the desktop app ending a session; whether the `Agent` tool needs an explicit allow in `-p`; how a worktree path with no plugin install entry resolves project-scope plugins; whether the second profile receives its own `remote-settings.json` proxy (check presence with `ls` only).
