---
name: new-agent
description: Hand a task to another Claude account as a one-shot agent, like a subagent, running on that account's own quota. Use when the user wants a task done by another account, or invokes `/new-agent <task>`.
---

# new-agent

Run a task on another Claude account through the wingman MCP server. The run is one-shot: no resume, no follow-up messages. For more work, start a new run.

## Rules

- Never print, send or write sensitive values: tokens (Bearer, JWT, PAT, API keys), passwords, secrets, private keys, credentials in URLs, `.env` values, PII. Do not cat/Read files that may hold them.
- Never read `events.jsonl`, run logs or account credential files. Use only `wingman_result`, `wingman_status`, `wingman_list` and `git`.
- Every review comment posted to an MR/PR is written in English, whatever language the Human chats in.
- Never push, and never commit to the base branch. Merging and pushing stay with the caller.

## Steps

1. **Task and account.** The rest of the line after `/new-agent` is the task. An optional `--account <id>` names the target. Without it, call `wingman_start` without `account`; the server picks a random eligible target.
2. **Preset.** Choose it yourself and say which: `readonly` for lookup, review and analysis; `edit` when files must change.
3. **Prompt.** The run has no conversation context, so write a self-contained prompt: goal, paths, constraints, expected output. For `edit`, run in a `worktree` from a feature branch (check `git rev-parse --abbrev-ref HEAD`, never the base branch) and commit what the run needs first; changes land on a run branch. Keep the returned `run_id` and run branch.
4. **Wait without polling.** Start `${CLAUDE_PLUGIN_ROOT}/bin/wingman-wait <run_id>` with Bash `run_in_background`. It prints `WINGMAN_RUN <id> <status>` and wakes you on exit (0 for done/partial, 1 other terminal statuses, 2 unknown run, 3 timeout).
5. **On wake, read `wingman_result`** (masked and capped). For `edit` runs, review the run branch from the main checkout:
   - `git diff --stat <caller-branch>...<run-branch>`
   - `git diff <caller-branch>...<run-branch> | grep -c -iE 'bearer|token|secret|password|jwt|authorization|api[_-]?key'`
   - Read a hunk only when the count is 0 or the match is judged harmless by file and function name, never by printing the line.
6. **Cleanup, case by case.** Propose it yourself: accept or discard the worktree, then `wingman_cleanup` (the run branch is kept). Ask the user only for destructive or ambiguous cases. Merging and pushing stay with the caller.

## Statuses

- `done` / `partial`: review as in step 5; for `partial`, list what remains and offer a new run.
- `blocked`: show the report and ask the user.
- `needs_input`: relay the question; the answer goes into a new run with a fresh prompt.
- `needs_caller`: something must be done in the caller session (for example a plugin install). Do it, then start a new run.
- `rate_limited`: tell the user when the limit resets. The caller decides to wait or start a new run on another account; never reroute automatically.
- `failed`: report it with the masked result and propose a new run or stop.
- `failed_no_report`: the run ended without a result (for example killed by a DLP block). Inspect the run branch with `git log` and `git diff --stat` only, then start a new run or stop.
- `cancelled`: report it and clean up per step 6.
