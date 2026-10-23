# wingman: implementation plan (Gate 0 to v0.1)

Scope: everything needed for `os-apply` of a small change to run on a second account from the caller session, packaged as an installable plugin. Later phases are in `ROADMAP.md`; decisions are in `DESIGN.md`.

Rules for every step: no sensitive values read or printed (check files with `grep -c` first, report structure only); work on a feature branch, never the base branch; each step ends with its check passing before the next starts.

## Layout

```
wingman/                      plugin root (this dir, to be renamed)
  .claude-plugin/plugin.json
  .mcp.json                   registers the MCP server
  server/                     TypeScript, Node 22
    src/index.ts              MCP stdio entry, tool handlers
    src/registry.ts           accounts.json read/write, status expiry
    src/runs.ts               run dirs, meta, event log, capped summaries
    src/runner.ts             detached runner process (one per run)
    src/worktree.ts           git worktree + branch per run
    src/guard.ts              appended system prompt, tool/permission policy
    src/self.ts               caller profile detection, depth guard
    test/
  bin/wingman-wait            blocks until a run ends
  bin/wingman                 CLI: add-account, list, disable, enable, mark-limited
  skills/
    delegate-apply/SKILL.md
    pick-account/SKILL.md
    add-account/SKILL.md
  another-login.sh            first-time login helper
  DESIGN.md ROADMAP.md PLAN.md
```

## Steps

### 0. Gate 0: verify before building (user logs in, we verify)
1. User runs `./another-login.sh`, `/login`, `/status`, exits.
2. Verify with `ls -la` and `stat` only: the second profile has its own `.credentials.json`; the first profile's `.credentials.json` mtime is unchanged.
3. `CLAUDE_CONFIG_DIR=<dir> claude -p "reply ok" --output-format json` succeeds.
4. `CLAUDE_CONFIG_DIR=<dir> claude plugin list` shows `ailab-agent`; a headless call runs a harmless skill (`os-onboard`).
5. Engine comparison on the same trivial prompt, under the second profile: (a) Agent SDK `query()` with `settingSources` set so CLAUDE.md, skills and plugins load; (b) `claude -p --output-format stream-json`. Record what each loads, how `resume` works, how rate-limit errors surface, and pick one. Default pick if equal: `claude -p` stream-json (fewer moving parts, same binary the user runs).
6. Note for the user: user-scope MCP servers (redmine, grafana) are per profile and will be absent in the target.

Exit: engine chosen and written into `DESIGN.md`; findings listed.

### 1. Scaffold the plugin
- Initialise git on a feature branch; `plugin.json` (name `wingman`), `.mcp.json` pointing at the built server, `package.json`, `tsconfig`, a test runner (vitest), lint/format.
- Rename the working dir to `wingman/` (done outside the session or at the start of a new one).
- Check: `npm run build` and `npm test` pass on an empty skeleton; plugin loads with `claude --plugin-dir`.

### 2. Registry and self-detection (`registry.ts`, `self.ts`)
- `~/.wingman/accounts.json` schema from `DESIGN.md`; read, write atomically, expire `rate_limited` when `limited_until` has passed.
- Caller profile = realpath of `CLAUDE_CONFIG_DIR` or `~/.claude`; match it to a registry entry; exclude it from targets. `WINGMAN_DEPTH` guard.
- Tests: expiry, self-exclusion, symlinked config dirs resolve to the same profile, missing file creates an empty registry.

### 3. Run storage (`runs.ts`)
- `~/.wingman/runs/<id>/` with `meta.json` (account, cwd, branch, session id, status, timestamps, pid), `events.jsonl` (raw, never returned), `result.md` (final report).
- Capped summaries: status and result are truncated to a fixed size; tests assert raw tool output never appears in what the server returns.

### 4. Runner (`runner.ts`, `guard.ts`, `worktree.ts`)
- Detached `spawn` (`detached: true`, `unref`), stdout streamed to `events.jsonl`; exit code, timeout and `max_turns` recorded in `meta.json`.
- Environment: `CLAUDE_CONFIG_DIR` set to the target; `WINGMAN_DEPTH` incremented; proxy variables left as the user's setup requires.
- Appended system prompt from `guard.ts`: sensitive-values rule, never commit to the base branch, no questions (write the blocker and stop), final report at the end of the run.
- Permissions: `acceptEdits` plus a narrow `allowedTools` passed by the caller; deny `git push` to the base branch and force pushes; no bypass flag.
- Worktree: when `cwd` is a repo, create a worktree on `<type>/<name>` from the latest base (fetch first, retry on 503; internal git host fetches run with proxy variables removed), refuse the base branch.
- Rate-limit detection from the event stream: set `status: rate_limited` on the run and the account, with the reset time when it can be parsed.
- Tests with a fake `claude` binary: normal finish, non-zero exit, timeout, cancel, rate limit, worktree refused on the base branch.

### 5. MCP server (`index.ts`)
- Tools: `wingman_start`, `wingman_status`, `wingman_result`, `wingman_send` (resume by stored session id on the same account only), `wingman_cancel`, `wingman_list`, `wingman_accounts`.
- Stateless: every call reads run state from disk, so a run survives the caller session.
- Check: MCP inspector call of each tool against the fake binary; then one real trivial run under the second profile.

### 6. CLI helpers
- `wingman-wait <run_id>`: poll `meta.json`, exit when the run is finished, print only the final status line.
- `wingman` subcommands: `add-account <name> [dir]` (replaces `another-login.sh` once stable), `list`, `disable`, `enable`, `mark-limited --until`.

### 7. Skills
- `delegate-apply`: caller commits the change artifacts on a feature branch, calls `wingman_start` with `/ailab-agent:os-apply <name>` and the allowed tools the project's checks need, starts `wingman-wait` with `run_in_background`, then reads the capped report and the branch diff stat. The caller reviews before accepting; unticked tasks and `Human:` findings go back to the user.
- `pick-account`: selection policy from `DESIGN.md`.
- `add-account`: how to log in a new profile and register it.
- Skills carry the sensitive-values rule and the English-for-review-comments rule so briefs inherit them.

### 8. End-to-end verification
1. Trivial prompt on the second account through the MCP server.
2. Detached survival: close the caller session mid-run, reopen, read the result.
3. `os-apply` of a small real change in a throwaway repo: report capped, branch on the worktree, base branch untouched.
4. Rate-limit path with the fake binary; role swap by starting from the second profile and delegating to the first.
5. Review: independent reviewer subagent over the whole diff (correctness, security, DLP leakage, process cleanup).

### 9. Packaging
- Build output committed or built at install; `README` with install and `add-account`; version `0.1.0`; install the plugin into the default profile and confirm the second profile sees it through the shared `plugins/`.

## Parallelisation

After step 1: steps 2 and 3 are independent (separate files); step 4 needs both; steps 6 and 7 can run in parallel with step 5 once the tool contracts in `DESIGN.md` are fixed. Implementation goes to `sonnet` agents from this plan, review of step 8 to an `opus` agent; Gate 0 and the engine choice stay in the main session.

## Open points

- Engine (decided in step 0).
- Whether `wingman_start` should accept a ready list of `allowed_tools` presets (for example `os-apply` needs the project's check commands).
- Name of the plugin marketplace entry and where it is published internally.
