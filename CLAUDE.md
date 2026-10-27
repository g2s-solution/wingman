# wingman

Delegates work from one Claude Code profile to another account through an MCP server (`wingman`). Design in `DESIGN.md`, steps in `PLAN.md`, phases in `ROADMAP.md`.

- Status: v0.1 merged and installable (server, wingman-wait, new-agent skill, marketplace, README). Open: remaining Gate 0 checks, then v0.2 (see `ROADMAP.md`).
- Shell scripts must pass `bash -n` (and `shellcheck` when installed); a hook runs both after edits.
- Conventions: see the `project-conventions` skill. Review security-sensitive changes with the `security-reviewer` agent.
- Never read or print credential files; the hook blocks edits to them.
