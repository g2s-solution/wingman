---
name: project-conventions
description: Wingman design conventions (account parameter, runner interface, masking, no push). Background knowledge for writing or reviewing wingman code.
user-invocable: false
---

- Tools take an `account` parameter; no code, name or comment mentions "A" or "B", so 2 to N accounts needs no rewrite.
- Claude-specific parts (command line, env variable, event format, system prompt injection) live behind one runner interface (`adapters/claude.ts`); other providers plug in as adapters.
- Child runs get an env allowlist, never the parent env. Output is masked and capped before it reaches the caller.
- Guardrails for delegated runs: no push, no plugin management, no recursion (depth guard).
- `DESIGN.md` holds the concepts and tool contracts, `docs/history/PLAN.md` the v0.1 steps, `ROADMAP.md` the phases. Read them before changing a contract.
