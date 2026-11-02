# Changelog

Versions are the plugin version in `wingman/.claude-plugin/plugin.json`. Claude Code only updates an installed plugin when this number changes.

## 0.4.6

- Model tiers per account: `wingman accounts add --haiku M --sonnet M --opus M` (`-` clears a tier). `wingman_start` with `model: "haiku" | "sonnet" | "opus"` uses the account's model for that tier; unset tiers and other values pass through unchanged. `accounts list` shows a MODELS column and `wingman_accounts` returns `models`.

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
