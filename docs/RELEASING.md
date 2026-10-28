# Releasing

Plugin versions are bumped by hand (Dependabot does not touch them).

1. Decide the version: patch for fixes and docs under `wingman/`, minor for new features.
2. Bump `version` in `wingman/.claude-plugin/plugin.json` and `wingman/server/package.json`, then refresh the lockfile: `npm install --package-lock-only --ignore-scripts` in `wingman/server`.
3. Rebuild the bundle: `npm run build` in `wingman/server`, and commit `dist/`.
4. Add the release to `CHANGELOG.md`.
5. Run `./scripts/check_quality.sh`.
6. Open a pull request. Merge only when `gh pr checks <pr>` shows `quality` as `pass` (never on `fail` or `pending`; fix the cause instead of retrying).
7. Tag and publish from `main`: `gh release create vX.Y.Z --target main --notes-file <notes.md>`.
8. Update an installed plugin:
   ```bash
   claude plugin marketplace update wingman-marketplace && claude plugin update wingman@wingman-marketplace
   ```
   `claude plugin update` only picks up a change when the version number changes; an unchanged number keeps the old cached copy.
9. Verify in a fresh Claude Code session (`/plugin` shows the new version, and a short run works).
