# Contributing

Thanks for helping. This is a small project; keep changes focused.

## Set up

```bash
git clone git@github.com:g2s-solution/wingman.git
cd wingman/wingman/server
npm ci
```

Node 22 or newer. Tests use a fake `claude` binary and a temporary `WINGMAN_HOME`; they never call the real CLI or touch your `~/.wingman`.

## Before a pull request

Run the quality gate from the repository root:

```bash
./scripts/check_quality.sh
```

It runs typecheck, lint, prettier, a build, the tests with a coverage gate of 80%, `bash -n` and `shellcheck` on shell scripts (shellcheck is optional locally, required in CI), JSON validation and a plugin version check. CI runs the same script on every pull request, and a pull request should be merged only when it is green.

- The committed bundle `wingman/server/dist/index.js` must match a fresh build: run `npm run build` and commit it.
- If you change anything users run (server, skill, `bin/`), bump `version` in `wingman/.claude-plugin/plugin.json` and `wingman/server/package.json` (and the lockfile) and add a line to `CHANGELOG.md`. An unchanged version number keeps the old copy for installed users.
- Add a test for a behavior change; keep the tests deterministic (poll for conditions instead of fixed sleeps).
- Never put real tokens, keys or personal data in code, tests, logs or issues. Build fake secrets from fragments at runtime in tests.

## Project files

- `CODE_OF_CONDUCT.md`: how we treat each other.
- `docs/RELEASING.md`: the release checklist.
- `.github/pull_request_template.md`: the pull request template; fill it in.

## Design

Read `DESIGN.md` before changing guardrails, the run lifecycle or the tool contracts. Security-sensitive changes (masking, environment allowlist, worktree and lock handling, process cancellation, `another-login.sh`) deserve an independent review; see `SECURITY.md` for what counts.
