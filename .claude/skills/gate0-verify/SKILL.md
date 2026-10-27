---
name: gate0-verify
description: Run the Gate 0 checks from docs/history/PLAN.md step 0 against the second Claude profile and report pass/fail per check. Use when the user says "gate0", "verify the second profile" or after a plugin update.
disable-model-invocation: true
---

Run the checks of `docs/history/PLAN.md` section "0. Gate 0" in order and report one line per check: `PASS`, `FAIL` or `SKIP` with a short reason. Read `docs/history/PLAN.md` first; it is the source of truth.

Rules:
- Never read, cat or print credential files (`.credentials.json`, `remote-settings.json` contents). Use `ls -la` for existence and mode only.
- Compare accounts with `claude auth status --json` under each profile and `jq`, printing only `same` or `different`, never the values.
- The second profile directory comes from `another-login.sh` output or the user; ask if unknown.
- Steps that need a real Claude Code session (step 5) or the user's choice (step 7, engine) are reported as `SKIP` with what the user must do; do not guess.
- Finish with the open points that remain (engine, permission mode).
