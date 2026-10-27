# wingman

Delegates work from one Claude Code profile to another account through an MCP server (`wingman`). Design in `DESIGN.md`, steps in `PLAN.md`, phases in `ROADMAP.md`.

- Status: v0.1 merged and installable (server, wingman-wait, new-agent skill, marketplace, README). Open: remaining Gate 0 checks, then v0.2 (see `ROADMAP.md`).
- Shell scripts must pass `bash -n` (and `shellcheck` when installed); a hook runs both after edits.
- Conventions: see the `project-conventions` skill. Review security-sensitive changes with the `security-reviewer` agent.
- Change anything under `wingman/` that users run (server, skill, bin): bump `version` in `wingman/.claude-plugin/plugin.json` and `wingman/server/package.json` and rebuild `dist/`; `claude plugin update` compares the version, so an unchanged number keeps the old cached copy.
- Never read or print credential files; the hook blocks edits to them.
