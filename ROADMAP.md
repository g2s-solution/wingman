# wingman: roadmap

Concepts and decisions are in `DESIGN.md`; the original v0.1 build plan is kept in `docs/history/PLAN.md`. Two principles hold for every phase: tools take an `account` parameter and no code mentions "A" or "B" (so going from 2 to N accounts needs no rewrite), and everything specific to Claude Code (command line, environment variable, event format, system prompt injection) stays behind the runner interface so other providers plug in as adapters.

The order follows dependencies: first make the public project healthy, safe and portable, then manage accounts, then act on account state, and only then choose targets by policy, continue runs and add providers.

## Done

**v0.1** (released as 0.1.x): MCP server `wingman` with `wingman_start`, `wingman_status`, `wingman_result` (paged), `wingman_cancel`, `wingman_list`, `wingman_cleanup`; detached one-shot runs with state on disk; environment allowlist; a worktree per run cut from the caller's HEAD, with lock and cleanup; `readonly` and `edit` presets; guardrails (prompt, `WINGMAN_STATUS`, no push, no plugin management, no recursion, ref, config and hooks snapshot); masked output; `rate_limit_event` recorded per run; `wingman-wait`; skill `new-agent`; `another-login.sh` (login, launcher, registry entry); CI and a quality gate.

**v0.2** (0.2.0): the prompt goes to the agent over stdin (not visible in `ps`); preset `edit-files` (no `node`, `npm`, `Agent`, `Skill`); `proc.ts` platform layer (`/proc` on Linux, `ps` on macOS) with a macOS CI job; `wingman wait` and `wingman gc` in the bundle (old run directories, stale locks, orphan worktrees). The macOS path has had little real-world use.

**v0.3** (0.3.0): `wingman accounts` (list, add, disable, enable, remove), the read-only tool `wingman_accounts`, `wingman doctor` (offline and `--online`), the `add-account` skill. Mutations stay in the CLI on purpose.

**v0.4** (0.4.0): a run that ends `rate_limited` writes `status: rate_limited` and `limited_until` to its account; the limit expires on read (no job); selection skips limited accounts and an explicit limited account is refused naming `limited_until`; `wingman accounts mark-limited --until` and `clear-limited`; the `rate_limited` answer and a refused start name the other active accounts; `accounts list` and `wingman_accounts` report limited state and run counts per outcome; `wingman doctor` lists limited accounts as warnings.

## Planned

| Phase | Goal | Scope | Done when | Depends on |
|---|---|---|---|---|
| **v0.1.x** (patch releases) | Keep the public repository healthy. | Pin CI actions by SHA and add Dependabot; code of conduct, issue and PR templates, release checklist; remove timing-dependent tests (poll for conditions, never fixed sleeps); document retention of `~/.wingman` | CI actions pinned; the test suite passes three CI runs in a row without retries; templates exist | v0.1 |
| **v0.5 Selection policy** | Pick targets by policy instead of at random. | `tags`, `priority`, `scope`, filters; least-recently-used default; skill `pick-account`; failover stays the caller's decision | With three accounts, selection honors tags and priority and skips limited ones, in tests | v0.4 |
| **v0.6 Follow-ups and limits** | Continue work and avoid overloading an account. | Follow-up run on the same account (`--resume` with the recorded session id); per-account concurrency cap and an optional queue; optional sandbox wrapper (`bubblewrap`, `sandbox-exec`) for `edit`; `setup` restricted or opt-in | A follow-up run keeps the earlier context; N runs over M accounts never exceed the cap in a stress test; a documented attack test (`env git push`, `node -e`) is blocked under the sandbox | v0.2, v0.4 |
| **v0.7 Other providers** | Delegate to agents other than Claude Code. | Adapters for OpenAI Codex, OpenCode and similar CLIs behind the runner interface; an account's `provider` selects the adapter, which builds the command, sets the account selection variable (for example `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), injects the guardrail prompt, parses events and detects rate limits; guardrail and masking parity tests; per-provider sandbox notes | The same `wingman_*` tools drive a non-Claude run with the same masked, paged report | v0.3, v0.6 |

## Verification debt

Not verified yet, each owned by the phase that depends on it: spawning from a real interactive Claude Code session (v0.1.x), whether `--bg` background sessions work under a custom `CLAUDE_CONFIG_DIR` (v0.6), `acceptEdits` versus `auto` permission mode for `edit` (v0.3), whether the settings symlink survives a Claude Code rewrite (v0.3 `doctor`), and a Claude Code version compatibility matrix with a canary CI job (v0.3).

## Out of scope for now

Automatic failover without the caller's decision, a pre-run quota gauge, resuming a run on a different account.
