# claude-wingman

Hand a task from one Claude Code session (the caller) to another Claude account (the target) as a one-shot agent, like a subagent that runs on the target's own quota. Concepts and guardrails are in `DESIGN.md`, the build steps in `PLAN.md`, later phases in `ROADMAP.md`.

## Install

The repo is a plugin marketplace (`wingman-marketplace`) with one plugin, `wingman`. In the caller's profile:

```
/plugin marketplace add g2s-solution/claude-wingman
/plugin install wingman@wingman-marketplace
```

The MCP server is a committed bundle (`wingman/server/dist/index.js`, Node 22); nothing is built at install time. The plugin is needed only in the caller's profile: runs start with `--strict-mcp-config`, so the target loads no MCP servers.

## Log in the second profile

```bash
./another-login.sh [--method claudeai|console|api_key] [config-dir]
```

A bare name such as `claude-thinh` becomes `~/.claude-thinh`. The script signs in, prints the account and writes a launcher (for example `~/.local/bin/claude-thinh`) that sets `CLAUDE_CONFIG_DIR` and loads that profile's credential. Wingman never reads or stores credentials: it runs the launcher named in the registry.

## Register the target

`another-login.sh` registers the profile for you: after writing the launcher it adds or updates an entry in `~/.wingman/accounts.json` (id = the name without a leading `claude-`, so `claude-thinh` becomes `thinh`), keeps fields you set by hand such as `status`, and leaves an invalid file untouched. Nothing to do unless you want to edit the file yourself (directory mode 0700, file mode 0600):

```json
{
  "accounts": [
    {
      "id": "thinh",
      "label": "claude-thinh",
      "config_dir": "/home/<you>/.claude-thinh",
      "provider": "claude",
      "command": "/home/<you>/.local/bin/claude-thinh"
    }
  ]
}
```

`command` defaults to `claude` (use it for a profile signed in with `claude auth login`). The caller's own profile is never a target. Set `WINGMAN_HOME` to use another state directory.

## Use

In a session: `/new-agent <task>`. The skill chooses a preset, calls `wingman_start` (leave `account` out to get a random eligible target), runs `bin/wingman-wait` in the background and reads the masked, capped report.

| Tool | Purpose |
|---|---|
| `wingman_start` | start a run; `preset` is `readonly` (default) or `edit`; in a git repo it gets a worktree on `<branch>-wm-<runid>` cut from the caller's branch |
| `wingman_status`, `wingman_result` | state and the final report, masked and capped |
| `wingman_cancel` | stop a run |
| `wingman_list` | recent runs |
| `wingman_cleanup` | remove a run's worktree (`accept` refuses uncommitted changes); the run branch is always kept |

Run state lives in `~/.wingman/runs/<id>/`. Do not read `events.jsonl`: it holds raw tool output. Review an edit run with `git diff --stat <caller-branch>..<run-branch>`; merging and pushing stay with the caller.

## Limits

- The deny lists are advisory: the `edit` preset allows `node` and `npm`, which run arbitrary code. Use it only on repos you would let the target account change.
- A run cannot be resumed; start a new one.
- A run that changes the base branch, the caller branch ref or the repo's local git config ends as `needs_caller`.
- Rate limits are recorded per run; the caller decides whether to wait or start another run. There is no automatic failover.

## Develop

```bash
cd wingman/server
npm ci
npm run check   # typecheck, lint, prettier, build, tests (the committed dist must match a fresh build)
```

Tests use a fake `claude` binary and a temporary `WINGMAN_HOME`; they never call the real CLI.
