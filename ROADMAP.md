# wingman: roadmap

See `DESIGN.md` for the concepts and decisions and `PLAN.md` for the v0.1 steps. Naming rule from day one: tools take an `account` parameter and no code mentions "A" or "B", so going from 2 to N accounts needs no rewrite. Keep the Claude-specific parts (command line, env variable, event format, system prompt injection) behind one runner interface from v0.1, so other providers (v0.6) plug in as adapters instead of a rewrite.

| Phase | Scope | Done when |
|---|---|---|
| **Gate 0** | Log in the second profile (`another-login.sh`). Verify isolation with `claude auth status --json` (same or different account), plugin and skill loading, the real spawn context and env allowlist, shared state (`installed_plugins.json`, `settings.json` symlink, proxy settings). Compare the Agent SDK, `claude -p` stream-json and built-in background sessions as the engine; compare `acceptEdits` and `auto`. | A trivial task runs end to end under the second profile and the engine is chosen. |
| **v0.1** | MCP server `wingman`: async detached runs, run state on disk, env allowlist, worktree from the caller's feature branch with setup, lock and cleanup, guardrails (prompt, `WINGMAN_STATUS`, `os-apply` preset, no push, no plugin management), no-recursion guard, masked and capped output, `rate_limit_event` recorded per run, `wingman-wait`, skill `delegate-apply`, bundled plugin. One target picked by `id`. | `os-apply` of a small change runs on the second account and the caller reads a masked, capped report. |
| **v0.2** | N accounts: `pick-account` skill and rule, `scope`, `tags`, `priority`, `wingman_accounts`, CLI subcommands (`add-account`, `list`, `disable`, `enable`, `mark-limited --until`), `add-account` skill. | The caller picks a target from the registry without being told which. |
| **v0.3** | Account status machine: automatic `rate_limited` from `rate_limit_event` data, `limited_until` expiry, fallback hint to the caller. | A run that hits a limit marks its account and tells the caller. |
| **v0.4** | Role swap hardening: any profile can call any other (tested both ways); health check for symlinks, shared `plugins/` writes and plugin version. | Start from either profile and delegate to the other, with no recursion. |
| **v0.5** | Queue and concurrency limits per account, usage report per account. | Several runs are scheduled across accounts without overloading one. |
| **v0.6** | Other agent backends beyond Claude Code (OpenAI Codex, OpenCode, and similar CLIs). An account's `provider` selects an adapter that builds the command, sets the account selection variable (for example `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), injects the guardrail prompt, parses events, detects rate limits and resumes. | A run can be delegated to a non-Claude agent through the same `wingman_*` tools, with the same masked, capped report. |

Out of scope for now: automatic failover without the caller's decision, a pre-run quota gauge, cross-account session resume.
