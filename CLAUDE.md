# wingman

Delegates work from one Claude Code profile to another account through an MCP server (`wingman`). Design in `DESIGN.md`, steps in `PLAN.md`, phases in `ROADMAP.md`.

- Status: v0.1 implemented on a feature branch (server, wingman-wait, new-agent skill); packaging and docs pending.
- Shell scripts must pass `bash -n` (and `shellcheck` when installed); a hook runs both after edits.
- Conventions: see the `project-conventions` skill. Review security-sensitive changes with the `security-reviewer` agent.
- Never read or print credential files; the hook blocks edits to them.
