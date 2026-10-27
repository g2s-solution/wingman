# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it and the version (`wingman/.claude-plugin/plugin.json`).

You can expect an acknowledgement within a few days. This is a small project without a paid security team, so fixes are best effort.

## What counts

In scope: leaking credentials or raw tool output to the caller, bypassing the guardrails that wingman claims (the environment allowlist, masking and paging of results, refusing to run on a base branch, the ref, config and hooks snapshot, cancel signalling the wrong process), path or option injection through tool parameters, and unsafe file modes under `~/.wingman` or in `another-login.sh`.

Known limits that are documented and not vulnerabilities by themselves are listed under "Limits" in the README: the `edit` preset and the `setup` parameter run arbitrary code, the deny rules are advisory, and the prompt is visible in the process list of the machine.

## Handling secrets

Never include real tokens or keys in a report. Describe where one would appear and use a placeholder.
