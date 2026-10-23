# wingman: roadmap

See `DESIGN.md` for the concepts and decisions. Naming rule from day one: tools take an `account` parameter and no code mentions "A" or "B", so going from 2 to N accounts needs no rewrite. Keep the Claude-specific parts (command line, env variable, event format, system prompt injection) behind one runner interface from v0.1, so other providers (v0.6) plug in as adapters instead of a rewrite.

| Phase | Scope | Done when |
|---|---|---|
| **Gate 0** | Log in the second profile (`another-login.sh`, to become `add-account.sh <name>`). Verify isolation (own credentials, caller's untouched), `claude -p` works under it, it sees the `ailab-agent` plugin and can run a harmless skill. Compare Agent SDK and `claude -p` stream-json as the engine. | A trivial task runs end to end under the second profile. |
| **v0.1** | MCP server `wingman` with async detached runs, run state on disk, worktree per run, built-in guardrails, `wingman-wait`, registry already in place, self-detection. Skill `delegate-apply` for `os-apply`. Plugin packaging. | `os-apply` of a small change runs on the second account and the caller reads a capped report. |
| **v0.2** | N accounts: `pick-account` skill and rule, `disable`, `enable`, `mark-limited --until`, `tags`, `scope`. | The caller picks a target from the registry without being told which. |
| **v0.3** | Automatic rate-limit detection, `limited_until` expiry, `status: rate_limited` with fallback hint. | A run that hits a limit marks its account and tells the caller. |
| **v0.4** | Role swap hardening: any profile can call any other; depth limit; health check for symlinks and plugin version. | Start from either profile and delegate to the other, with no recursion. |
| **v0.5** | Queue and concurrency limits per account, usage report per account. | Several runs are scheduled across accounts without overloading one. |
| **v0.6** | Other agent backends beyond Claude Code (OpenAI Codex, OpenCode, and similar CLIs). An account gets a `provider` field; each provider has an adapter that builds the command, account selection variable (for example `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), guardrail prompt injection, event parsing, rate-limit detection and resume. | A run can be delegated to a non-Claude agent through the same `wingman_*` tools, with the same capped report. |

Out of scope for now: automatic failover without the caller's decision, reading exact remaining quota, cross-account session resume.
