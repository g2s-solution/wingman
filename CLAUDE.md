# wingman

Delegates work from one Claude Code profile to another account through an MCP server (`wingman`). Design in `DESIGN.md`, original build plan in `docs/history/PLAN.md`, phases in `ROADMAP.md`.

- Status: v0.1 merged and installable (server, wingman-wait, new-agent skill, marketplace, README). Open: a few verification checks, then v0.2 (see `ROADMAP.md`). The repo is public: keep internal hosts, names and tokens out of everything committed.
- Shell scripts must pass `bash -n` (and `shellcheck` when installed); a hook runs both after edits.
- Conventions: see the `project-conventions` skill. Review security-sensitive changes with the `security-reviewer` agent.
- Change anything under `wingman/` that users run (server, skill, bin): bump `version` in `wingman/.claude-plugin/plugin.json` and `wingman/server/package.json` and rebuild `dist/`; `claude plugin update` compares the version, so an unchanged number keeps the old cached copy.
- Quality gate: run `scripts/check_quality.sh` before a PR (format, lint, types, build freshness, tests with coverage >= 80%, shell scripts, JSON, plugin version). CI (`quality` job) runs the same script on every PR.
- Merge only when `gh pr checks <pr>` shows `quality` as `pass`; never merge on `fail` or `pending`, and fix the cause instead of retrying. `main` is protected on GitHub (the `quality` check is required); the rule still applies to anything that bypasses it.
- Never read or print credential files; the hook blocks edits to them.
