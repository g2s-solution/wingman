---
name: delegate-apply
description: Run `os-apply` of an OpenSpec change on the second Claude account through the wingman MCP server, in a detached run on its own worktree and branch. Use when the user wants to delegate, offload or run os-apply of a change on the other account, or says "delegate apply", "apply on the second account" or "wingman apply".
---

# delegate-apply

Delegate `/ailab-agent:os-apply <change>` to another account and review the result. The caller never implements the change itself.

## Rules

- Never print, send or write sensitive values: tokens (Bearer, JWT, PAT, API keys), passwords, secrets, private keys, credentials in URLs, `.env` values, PII. Do not cat/Read files that may hold them.
- Never read `events.jsonl`, run logs or account credential files. Use only `wingman_result`, `wingman_status`, `wingman_list` and `git`.
- Every review comment posted to an MR/PR is written in English, whatever language the Human chats in.
- Never push, and never commit to the base branch. Merging the run branch and any push stay with the caller and `os-mr`.

## Steps

1. **Version gate.** Run `check-version-plugin.mjs --gate` (from the ailab-agent plugin) before delegating. A run must never self-update plugins, so a failed gate is fixed here, by the caller, before step 4.
2. **Commit the change artifacts** (proposal, specs, design, tasks) on a feature branch, never the base branch (`git rev-parse --abbrev-ref HEAD`). The run worktree is cut from the caller's HEAD, so uncommitted artifacts would be missing.
3. **Pick the account by id.** Ask the Human, or use the only registered target. Use `wingman_list` or the registry file name only; never read credentials.
4. **Start the run:** `wingman_start` with prompt `/ailab-agent:os-apply <change-name>`, preset `os-apply`, `change` set to the change name, worktree on, `cwd` the repo root. Keep the returned `run_id` and run branch.
5. **Wait without polling.** Start `${CLAUDE_PLUGIN_ROOT}/bin/wingman-wait <run_id>` with Bash `run_in_background`. It prints one line, `WINGMAN_RUN <id> <status>`, and wakes the caller on exit (exit 0 for done/partial, 1 for other terminal statuses, 2 for an unknown run, 3 for a timeout).
6. **On wake, read `wingman_result`** (masked and capped). Then review the run branch from the main checkout:
   - `git diff --stat <caller-branch>...<run-branch>`
   - `git diff <caller-branch>...<run-branch> | grep -c -iE 'bearer|token|secret|password|jwt|authorization|api[_-]?key'`
   - Read a hunk only after the count for it is 0 or the match is judged harmless by file and function name, never by printing the line.
7. **Report to the Human.** Unticked tasks in `tasks.md` and every `Human:` finding go back to the user as they are. Do not tick or fix them silently.
8. **Cleanup.** After the Human accepts or discards the run, call `wingman_cleanup`. Then, for an accepted run, merge or fast-forward the run branch yourself and continue with `os-mr`.

## Statuses

- `done` / `partial`: review as in step 6. `partial` means tasks remain; list them.
- `blocked`: the run hit something it could not resolve; show the report, ask the Human.
- `needs_input`: the run needs a Human decision; relay the question, then continue with `wingman_send` on the same run.
- `needs_caller`: a plugin install or update was requested. Do it in the caller session (step 1), then continue with `wingman_send`.
- `rate_limited`: tell the Human when the limit resets. The Human decides to wait or to start a new run on another account. Never reroute automatically.
- `failed_no_report`: the run ended without a result (for example killed by a DLP block). `wingman_send` is refused. Inspect the run branch with `git log` and `git diff --stat` only, then start a fresh run or stop.
- `failed` / `cancelled`: report it and the next options; clean up on the Human's word.
