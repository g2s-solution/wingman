## Description

<!-- What changes and why. -->

## Why's it safe?

- What covers the change (tests, checks):
- Remaining risk:
- How to undo it:

## Checklist

- [ ] Ran `./scripts/check_quality.sh`
- [ ] Added or updated tests
- [ ] If anything under `wingman/` that users run changed: bumped `version` in `wingman/.claude-plugin/plugin.json` and `wingman/server/package.json`, and rebuilt `wingman/server/dist`
- [ ] Added a line to `CHANGELOG.md`
- [ ] No secrets or personal data
