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

Fallback checklist: when you use the built-in Agent tool instead of wingman, state in one line which bullet above applies (tools missing, target rate limited or two failed runs, commands needed under `readonly`, or live context needed). If none applies, use wingman.

## Rules

- Never print, send or write sensitive values: tokens (Bearer, JWT, PAT, API keys), passwords, secrets, private keys, credentials in URLs, `.env` values, PII. Do not cat/Read files that may hold them.
- Never read `events.jsonl`, run logs or account credential files. Use only `wingman_result`, `wingman_status`, `wingman_list` and `git`. To follow a running run's progress, use the `wingman:progress` skill, which has a separate reader run read the log.
- Never push, and never commit to the base branch. Merging and pushing stay with the caller.
- The prompt for a run must not ask it to delegate or use wingman: the run cannot and will not delegate further.

## Steps

1. **Task and account.** The rest of the line after `/new-agent` is the task. An optional `--account <id>` names the target. Without it, call `wingman_start` without `account`; the server picks an eligible target at random, weighted by each account's `weight`.
2. **Preset.** Choose it yourself and say which: `readonly` for lookup and review; `edit-files` when only files change and no command is needed (documentation, config, code edits that you will test yourself): prefer it over `edit` whenever you can run the checks yourself afterwards; `edit` when the run must run commands (tests, builds). A command the preset does not allow is denied, not asked about: the run ends `partial` and the report lists the denied heads (the tool, and for `Bash` the first two words of the command) in `permission_denials` and in a `hint`; fix the prompt (the run starts in its working directory root: no `cd`, no `git -C`, `npm run <script>` not `npx`) or start a new run with another preset. `max_turns` defaults by preset (`readonly` 40, `edit-files` 100, `edit` 200); pass it only to change that. `edit` runs arbitrary code under the target account; its deny rules are advisory, not a sandbox, so use it only for tasks you would trust a subagent with.
   - **Worktree or not:** you decide with `worktree`. Defaults: a `readonly` run (no `allowed_tools`) runs in your `cwd` with no worktree, branch or lock, so it sees your uncommitted changes and starts at once; it cannot write, and it is allowed on `main` or a detached HEAD. A run that may commit (`edit-files`, `edit`, explicit `allowed_tools`) gets its own worktree, also from `main`; `worktree: false` is refused for it on a base branch or detached HEAD. An explicit value always wins.
     - Pass `worktree: true` when (a) the run must read the committed HEAD while you keep editing (a review of a branch or diff, a snapshot that must not move), (b) it needs `setup`, installed dependencies, builds or tests, (c) several runs work in the same repo at once and need isolation or a `lock_key`, (d) you have uncommitted changes it must not see.
     - Keep the default (no worktree) for lookups, code search, reading docs, and analysis of the current checkout including uncommitted changes, and when speed matters.
     - `setup` and `lock_key` are refused without a worktree: pass `worktree: true` with them.
   - **Branch:** an `edit-files` or `edit` run commits on a run branch (`<branch>-wm-<id>`, or `wingman/<id>` from a base branch) that you merge into your own feature branch. A `readonly` run has no branch (a detached worktree when you asked for one).
   - Call `wingman_cleanup` afterwards; for a run without a worktree it removes nothing and is harmless.
3. **Prompt.** The run has no conversation context, so write a self-contained prompt: goal, paths, constraints, expected output. Ask for a short report with the conclusion and any open question first, details after. For `edit`, commit what the run needs first (the worktree is cut from your current HEAD); changes land on a run branch. Keep the returned `run_id` and run branch.
4. **Wait without polling.** Start `${CLAUDE_PLUGIN_ROOT}/bin/wingman-wait <run_id>` with Bash `run_in_background`. It prints `WINGMAN_RUN <id> <status>` and wakes you on exit (0 for done/partial, 1 other terminal statuses, 2 unknown run, 3 timeout).
5. **On wake, read `wingman_result` to the end.** It is masked and comes in pages of 4000 characters: while the answer has `result_next_offset`, call again with `offset` set to it (`pages_left` says how many pages remain, `next` says what to call), and only judge the report once that field is gone (`result_total_chars` is the full length). If `wingman_result` says `still running`, do not re-read: wait with `wingman-wait`. For `edit` and `edit-files` runs, before merging you must do both of these from the main checkout (a hard requirement, not a suggestion):
   - `git diff --stat <caller-branch>...<run-branch>` (`wingman_cleanup` with `accept` also returns it as `diff_stat` with the `run_branch`; it is the same stat, not a review of the content)
   - `git diff <caller-branch>...<run-branch> | grep -c -iE 'bearer|token|secret|password|jwt|authorization|api[_-]?key'`
   - Read a hunk only when the count is 0 or the match is judged harmless by file and function name, never by printing the line. Do not merge a branch whose stat and count you have not seen.
6. **Cleanup, case by case.** Propose it yourself: accept or discard the worktree, then `wingman_cleanup` (the run branch, if there is one, is kept; readonly runs have none, and for them `accept` and `discard` are equivalent). Ask the user only for destructive or ambiguous cases. Merging and pushing stay with the caller.

## Statuses

- `done` / `partial`: review as in step 5; for `partial`, list what remains and offer a new run.
- `blocked`: show the report and ask the user.
- `no_status`: the run finished but its final message had no `WINGMAN_STATUS:` line (often after a denied command). The report is usually still usable: read it, check `permission_denials` and the `hint`, and fix the prompt (allowed tools only, end with the status line) before starting a new run.
- `needs_input`: relay the question; the answer goes into a new run with a fresh prompt.
- `needs_caller`: something must be done in the caller session: a plugin install or update, or a guardrail trip (the base branch, the caller branch ref, the git config or the git hooks changed while the run was active). For a plugin, do it and start a new run; for a guardrail note, inspect the refs with `git log --oneline` (never print config values) and decide with the user.
- `rate_limited`: tell the user when the limit resets. The caller decides to wait or start a new run on another account; never reroute automatically.
- `failed`: report it with the masked result and propose a new run or stop.
- `failed_no_report`: the run ended without a result (for example killed by a content filter or a crash). Inspect the run branch with `git log` and `git diff --stat` only, then start a new run or stop.
- `cancelled`: report it and clean up per step 6.
