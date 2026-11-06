# Changelog

Versions are the plugin version in `wingman/.claude-plugin/plugin.json`. Claude Code only updates an installed plugin when this number changes.

## 0.5.10

- The caller decides whether a run gets a worktree. In a git repo a `readonly` run (without `allowed_tools`) now runs in `cwd` by default: no `git worktree add`, no `setup`, no run branch, no lock, and it sees uncommitted changes. It is allowed on a base branch and on a detached HEAD, because the preset cannot commit; `Edit`, `Write` and `NotebookEdit` are also denied by name for readonly runs. Runs that may commit keep a worktree by default and keep the refusals of `worktree:false` on a base branch or detached HEAD. An explicit `worktree` always wins. `setup` and `lock_key` without a worktree are refused (the `setup` message says to pass `worktree:true`). The `worktree` and `wingman_start` descriptions and the `new-agent` skill (section "Worktree or not") say when to pass `worktree:true`. Behaviour change: callers that relied on a readonly run's detached worktree must pass `worktree:true`.

## 0.5.9

- New caller skill `progress` (`wingman:progress <run_id>`): follows a running run through one haiku reader run that reads its `events.jsonl` and returns a masked structural summary (elapsed time, tool calls by name, last file paths, a verdict `progressing`, `idle`, `stuck` or `finished`). The caller never reads the log itself. The reader session sees raw tool output, so a content-filter block ends it `failed_no_report`, and then the progress view is unavailable. The `new-agent` skill and the tool descriptions point to it.

## 0.5.8

- New terminal status `no_status`: a run that finishes cleanly but whose last message has no `WINGMAN_STATUS:` line. It used to be reported as `needs_input`, which mixed formatting misses (for example after a denied command) with real questions. It gets the same denied-commands `hint` as `partial`, is neutral for the failure circuit breaker, and `wingman wait` exits 1 for it like for `needs_input`. Older runs keep their recorded status.
- The guardrail prompt now says to put the report and the status line in the final message itself and to keep the status line when a command is denied. The `new-agent` skill documents `no_status`.

## 0.5.7

- Review fixes. `commitForAgent` (Codex) reads the staged paths with `git diff -z`, so a credential-looking file under a non-ASCII directory is no longer committed to the run branch (git C-quoted such paths and the name check missed them). `maskSecrets` masks `Authorization:` values of any scheme (`Token`, `ApiKey`, a bare value, and the like) and the Stripe live, Google, npm and Hugging Face key shapes. A failure to append to `events.jsonl` (full disk, run directory removed), from the agent's stdout or stderr, no longer crashes the supervisor and loses the run's result.
- Docs: `CLAUDE.md` status and the `ROADMAP.md` list of released versions are current.

## 0.5.6

- Failure circuit breaker: an account whose last 3 finished runs ended `failed` or `failed_no_report` (since its latest `done` or `partial`; `needs_input`, `blocked` and `cancelled` neither count nor reset) is limited for 30 minutes, the same state as a provider rate limit with `limited_reason: consecutive_failures`. The first failure after the cooldown trips it again at once; a `done` or `partial` run clears the streak. `accounts list`, `wingman_accounts` and the refusal messages show the reason; `clear-limited` lifts it early. `WINGMAN_BREAKER_FAILURES` (default 3, 0 = off) and `WINGMAN_BREAKER_COOLDOWN_MINUTES` (default 30) tune it. A run marked `failed_no_report` by `reconcile` after its supervisor died counts toward the streak but cannot trip the breaker itself. The cooldown is 1 minute to 7 days; `wingman doctor` reports a breaker limit with its reason.

## 0.5.5

- Weighted selection: an account can carry a `weight` (default 1). When `wingman_start` omits `account`, the server picks among the active, non-caller accounts with probability `weight / total`; a weight of 0 means the account is only used when named. `wingman accounts set-weight ID N` sets it (`default` removes it); `accounts list` and `wingman_accounts` show the weight and the current share, which is recomputed without limited or disabled accounts, so a limited account's share moves to the others. If every candidate has weight 0 the start is refused and says so. Weights run from 0 to 1000000 (a larger value would overflow the total).

## 0.5.4

- The hooks guardrail now hashes the directory from `git rev-parse --git-path hooks`, so a repository with `core.hooksPath` (for example husky) is covered; before, edits to the hooks that actually run went unnoticed.
- `setup` is refused with a clear error when the run has no worktree, instead of being accepted and silently ignored.
- `WINGMAN_HOME` is resolved to an absolute path, so a relative value means the same directory in the supervisor as in the MCP server.
- `wingman_cleanup` only deletes a leftover worktree directory that is inside `~/.wingman/worktrees`; the old string-prefix check also matched sibling paths such as `worktrees-old/`.
- `meta.json` keeps unknown fields when an older run is read and rewritten, so a newer version's data is not dropped.
- Docs: `edit-files` is described as running git and `date` (not "no commands"); paging fields on the last page; run-branch names in the cleanup section; `accounts remove` needs `--yes` after the preview; `CLAUDE.md` status; `wingman accounts` usage lists `mark-limited` and `clear-limited`.

## 0.5.3

- OpenCode provider: an account with `--provider opencode` runs `opencode run --format json --standalone` with the prompt on stdin, its `config_dir` mapped to the four XDG roots, and a per-run permission config (`OPENCODE_CONFIG_CONTENT`) that denies web fetches, nested agents and paths outside the worktree and allows only the preset's git/node/npm commands. OpenCode commits for itself. `allowed_tools` and `max_turns` are refused. `Adapter.buildEnv` receives the run's spec.

## 0.5.2

- A model name that fails validation (for example one starting with `-`) is now refused before a run, worktree or branch is created; it used to leave a run stuck in `running` with a detached worktree.

## 0.5.1

- Codex provider: an account with `--provider codex` runs `codex exec --json` under its own `CODEX_HOME` (read-only or workspace-write sandbox by preset, user config and rules ignored, guardrail prepended to the prompt). Codex cannot commit in a worktree, so wingman commits the run's changes on the run branch after the run. `allowed_tools` and `max_turns` are refused for it. `accounts add --provider P` defaults `--command` to `P`.
- `Adapter` gains `capabilities`, `buildPrompt` and `createLineParser`; the allowlisted environment moved to `adapters/env.ts`.

## 0.5.0

- Starts v0.5 "Other providers": the provider plumbing (0.4.5) and per-account model tiers (0.4.6) are in. The Codex and OpenCode adapters themselves are not in this release; accounts with a provider other than `claude` are rejected at start with "No adapter for provider".

## 0.4.6

- Model tiers per account (values are validated as model names: no leading dash, spaces or control characters, also for `model` in `wingman_start`): `wingman accounts add --haiku M --sonnet M --opus M` (`-` clears a tier). `wingman_start` with `model: "haiku" | "sonnet" | "opus"` uses the account's model for that tier; unset tiers and other values pass through unchanged. `accounts list` shows a MODELS column and `wingman_accounts` returns `models`.

## 0.4.5

- Provider plumbing for v0.5 (no behaviour change for Claude accounts): adapters are looked up by the account's `provider` (`src/adapters/index.ts`), the adapter decides what a rate-limit rejection is, the guardrail prompt has neutral wording for non-Claude providers, plugin-change detection and the doctor checks that only make sense for Claude profiles are skipped for other providers, `wingman_start` rejects `allowed_tools` for them, and `wingman accounts list` shows a PROVIDER column.

## 0.4.4

- New skill `remove-account`: pause an account, unregister it while keeping the profile, or remove the whole profile with `another-logout.sh`. `add-account` points to it.

## 0.4.3

- The `add-account` skill explains that an `api_key_unverified` profile shows `signed in no` until its key is active.

## 0.4.2

- `another-login.sh` has a new method `api_key_unverified` (menu option 4): it stores the key and does every other setup step but skips the sign-in check, for a key that is activated later.

## 0.4.1

- Denied commands are reported: `permission_denials` keeps the tool name and, for `Bash`, the first two masked words of the command (for example `Bash(cd /work)`). A `partial` run with denials gets a `hint` in `wingman_status` and `wingman_result` naming up to 5 denied heads.
- New rule 5 in the appended prompt: the run is already in the worktree root; no `cd`, no `git -C`, `npm run <script>` not `npx`. The final-report rule is now rule 6.
- Every `wingman_*` tool rejects unknown parameters with an error naming the key and, when close, the key meant (`unknown parameter "result_offset" for wingman_result (did you mean "offset"?)`). `wingman_result` on a running run adds a hint to wait with `bin/wingman-wait`.
- `wingman_result` paging adds `pages_left` and a `next` line next to `result_next_offset`.
- `wingman_cleanup` `accept` on a run with a branch returns `run_branch`, `diff_stat` (capped, never the diff) and a review note; on a readonly run it returns a note that accept and discard are equivalent. `discard` is unchanged.
- Default `max_turns` by preset when omitted: `readonly` 40, `edit-files` 100, `edit` 200; an explicit value always wins.
- Skill `new-agent`: hard requirement to check `diff_stat`/`git diff --stat` and the secret-count grep before merging an edit run, a fallback checklist for the built-in Agent tool, guidance on `edit-files` and denied heads, and the paging fields.

## 0.4.0

- Account status: a run that ends `rate_limited` marks its account `rate_limited` with `limited_until` (from the run's reset time) in the registry. The limit expires on read, with no background job; old registry files without the new field stay valid.
- A limited account is skipped when `wingman_start` has no `account`, and refused (naming `limited_until`) when named. The `rate_limited` result and a refused start list the other active accounts; nothing is rerouted.
- New CLI: `wingman accounts mark-limited ID --until <ISO time with Z or an offset | date | epoch seconds>` and `wingman accounts clear-limited ID`. `enable` and `disable` drop `limited_until`.
- `wingman accounts list` and the read-only `wingman_accounts` tool show the limited state and, per account, the number of finished runs by status (from `meta.json` only). `wingman_status` and `wingman_result` are now async handlers internally; their output only gains `other_active_accounts` and `hint` on a `rate_limited` run.
- `wingman doctor` reports a limited account as a warning and still exits 0.

## 0.3.1

- Role swap: `wingman accounts add` may register your own profile (a note is printed); every profile skips itself when choosing a target, so a registry listing all profiles lets each one delegate to the others. README has a new section "Delegate in both directions".
- `another-login.sh` now also links `plugins` from the default profile, so all profiles share plugins, skills and settings. For an existing profile with a real `plugins/` directory the script and `wingman doctor` print the two commands that migrate it; nothing is moved automatically.
- No delegation loops: a delegated run is told it must never delegate further (new rule 4 of the appended prompt) and the `SessionStart` hook no longer injects the "prefer new-agent" instruction inside a run. The hard guards are unchanged (depth, no wingman tools in a run).

## 0.3.0

- Manage accounts without editing JSON: `wingman accounts list|add|disable|enable|remove` (run as `node <plugin dir>/wingman/bin/wingman accounts ...`). `another-login.sh` now registers the profile through it. `remove` needs `--yes` and never touches the profile directory or credentials.
- New read-only MCP tool `wingman_accounts` (id, label, status, whether it is your own profile). There is deliberately no tool that adds or changes accounts: a registry entry's `command` is executed by the runner, so mutations stay in the CLI.
- `wingman doctor [--online] [--json]`: checks the state directory and file modes, the registry, each account's config directory and launcher, the links to the default profile, and the wingman version in each profile; `--online` confirms each profile is signed in without printing any account details.
- New skill `add-account` that guides you through adding a second account; it never enters credentials for you.

## 0.2.0

- Safer: the prompt is sent to the agent over stdin, so it no longer shows in the process list (the static guard text is still an argument).
- New preset `edit-files` for runs that only change files: no `node`, `npm`, `Agent` or `Skill`. The skill picks `readonly`, `edit-files` or `edit`.
- macOS: process checks (pid reuse, orphan-group kill) use `ps` where `/proc` does not exist; CI runs the tests on macOS too.
- New CLI inside the bundle: `wingman wait <run_id>` (what `wingman-wait` now runs) and `wingman gc [--older-than-days N] [--dry-run]`, which removes old finished run directories, stale locks and orphan worktrees (never branches).

## 0.1.5

- The plugin adds a `SessionStart` hook that injects a short instruction into each session: when you ask for a subagent, delegation or an independent review, Claude calls `wingman:new-agent` before the built-in Agent tool. The hook only prints a static file (`hooks/session-start.json`); it runs no other code.

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
