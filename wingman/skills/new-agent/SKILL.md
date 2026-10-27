---
name: new-agent
description: Delegate a task to another Claude account as a one-shot agent that runs on that account's own quota in its own git worktree. PREFER this over the built-in Agent or subagent tool whenever the user says to use a subagent, a sub-agent or an agent, to delegate or hand off a task, to run it on the other or second account, or asks for an independent review, a second opinion or a self-review. Also invoked as `/wingman:new-agent <task>`.
---

# new-agent

Run a task on another Claude account through the wingman MCP server. The run is one-shot: no resume, no follow-up messages. For more work, start a new run.

## When to use this instead of the built-in Agent tool

Use this skill first, not the Agent tool, when the user asks for a subagent, an agent, delegation, a review by someone else, or work "on the other account". It saves the caller's quota, runs on a different account (a more independent reviewer) and cannot touch your checkout.

Use the built-in Agent tool instead, and say why in one line, when:
- the wingman tools are not available (plugin or MCP server missing, or no other account registered: `No other active account is registered to run on`);
- the target is `rate_limited` or a run failed twice (`failed`, `failed_no_report`);
- the task needs to run tests, builds or other commands under the `readonly` preset (it cannot), and you would not trust `edit` with it;
- the task needs the live conversation or tools only this session has; a wingman run starts with no context, so everything it needs must be in the prompt.

Never start both for the same task unless the user asks.

## Rules

- Never print, send or write sensitive values: tokens (Bearer, JWT, PAT, API keys), passwords, secrets, private keys, credentials in URLs, `.env` values, PII. Do not cat/Read files that may hold them.
- Never read `events.jsonl`, run logs or account credential files. Use only `wingman_result`, `wingman_status`, `wingman_list` and `git`.
- Never push, and never commit to the base branch. Merging and pushing stay with the caller.
- The prompt for a run must not ask it to delegate or use wingman: the run cannot and will not delegate further.

## Steps

1. **Task and account.** The rest of the line after `/new-agent` is the task. An optional `--account <id>` names the target. Without it, call `wingman_start` without `account`; the server picks a random eligible target.
2. **Preset.** Choose it yourself and say which: `readonly` for lookup and review; `edit-files` when only files change and no command is needed (documentation, config, code edits that you will test yourself); `edit` when the run must run commands (tests, builds). `edit` runs arbitrary code under the target account; its deny rules are advisory, not a sandbox, so use it only for tasks you would trust a subagent with.
   - **Worktree:** inside a git repo every run gets its own worktree by default, also when you are on the base branch (`main`, `master`): the target never touches your checkout. Pass `worktree: false` only for a pure lookup that needs no isolation; it is refused on a base branch. A detached HEAD is refused either way. `lock_key` (optional) stops two runs in the same repo with the same key, and needs a worktree.
   - **Branch:** an `edit-files` or `edit` run commits on a run branch (`<branch>-wm-<id>`, or `wingman/<id>` from a base branch) that you merge into your own feature branch. A `readonly` run gets a detached worktree and no branch.
   - Call `wingman_cleanup` afterwards.
3. **Prompt.** The run has no conversation context, so write a self-contained prompt: goal, paths, constraints, expected output. Ask for a short report with the conclusion and any open question first, details after. For `edit`, commit what the run needs first (the worktree is cut from your current HEAD); changes land on a run branch. Keep the returned `run_id` and run branch.
4. **Wait without polling.** Start `${CLAUDE_PLUGIN_ROOT}/bin/wingman-wait <run_id>` with Bash `run_in_background`. It prints `WINGMAN_RUN <id> <status>` and wakes you on exit (0 for done/partial, 1 other terminal statuses, 2 unknown run, 3 timeout).
5. **On wake, read `wingman_result` to the end.** It is masked and comes in pages of 4000 characters: while the answer has `result_next_offset`, call again with `offset` set to it, and only judge the report once that field is gone (`result_total_chars` is the full length). For `edit` runs, review the run branch from the main checkout:
   - `git diff --stat <caller-branch>...<run-branch>`
   - `git diff <caller-branch>...<run-branch> | grep -c -iE 'bearer|token|secret|password|jwt|authorization|api[_-]?key'`
   - Read a hunk only when the count is 0 or the match is judged harmless by file and function name, never by printing the line.
6. **Cleanup, case by case.** Propose it yourself: accept or discard the worktree, then `wingman_cleanup` (the run branch, if there is one, is kept; readonly runs have none). Ask the user only for destructive or ambiguous cases. Merging and pushing stay with the caller.

## Statuses

- `done` / `partial`: review as in step 5; for `partial`, list what remains and offer a new run.
- `blocked`: show the report and ask the user.
- `needs_input`: relay the question; the answer goes into a new run with a fresh prompt.
- `needs_caller`: something must be done in the caller session: a plugin install or update, or a guardrail trip (the base branch, the caller branch ref or the git config changed while the run was active). For a plugin, do it and start a new run; for a guardrail note, inspect the refs with `git log --oneline` (never print config values) and decide with the user.
- `rate_limited`: tell the user when the limit resets. The caller decides to wait or start a new run on another account; never reroute automatically.
- `failed`: report it with the masked result and propose a new run or stop.
- `failed_no_report`: the run ended without a result (for example killed by a content filter or a crash). Inspect the run branch with `git log` and `git diff --stat` only, then start a new run or stop.
- `cancelled`: report it and clean up per step 6.
