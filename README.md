# wingman

Hand a task from your Claude Code session to a **second Claude account** and get a report back, like a subagent that runs on the other account's own quota. You keep working in your session; the other account does the task in its own isolated git worktree.

```
you:    /wingman:new-agent review the diff on this branch for bugs
claude: starts a run on the second account (readonly, own worktree), waits, reads the report
you:    get the findings; nothing in your checkout changed
```

> **Read first**
>
> - Wingman runs tasks on an account that you set up. Whether you may use a second account this way is governed by Anthropic's terms, your plan and your organization's policy. That is your responsibility. Use only accounts you own or are authorized to use.
> - The `edit` preset runs arbitrary code under the target account, and the `setup` parameter runs an arbitrary shell command as you. Deny rules are advisory, not a sandbox. Use `edit` only on repositories you would let the target account change. See [Limits](#limits).
> - `another-login.sh` links parts of your default profile into the second one (see [Create the second profile](#2-create-the-second-profile)).

## Requirements

- Claude Code with plugin support (tested with 2.1.311) on the machine of the session that delegates (the *caller*).
- Node.js 22 or newer (runs the bundled MCP server; CI tests on 22 and 26), `git`, `bash`.
- A second Claude login: a claude.ai plan, a Console account or an API key. It must be different from the account of your caller session.
- Linux or macOS. Run supervision (the pid-reuse check and the orphan-process kill) reads `/proc` on Linux and uses `ps` on macOS; the `ps` path is unit-tested with canned output and exercised by the macOS CI job, but has had little real-world use. The login script falls back to `python3` where `realpath -m` is missing (macOS).

Terms used in these docs: the **caller** is the session you type in, the **target** is the account that runs the task, a **profile** is a Claude config directory (`CLAUDE_CONFIG_DIR`), and a **run** is one delegated task.

## 1. Install the plugin

In the caller's Claude Code:

```
/plugin marketplace add g2s-solution/wingman
/plugin install wingman@wingman-marketplace
```

Restart the session. The plugin is only needed in the caller's profile; the target loads no MCP servers. To update later:

```bash
claude plugin marketplace update wingman-marketplace && claude plugin update wingman@wingman-marketplace
```

Claude Code updates a plugin only when its version number changes (see `CHANGELOG.md`).

## 2. Create the second profile

Clone this repository (the login script is not part of the plugin) and run:

```bash
./another-login.sh [--method claudeai|console|api_key] [config-dir]
```

A bare name such as `claude-second` becomes `~/.claude-second`; a value containing `/` or `~` is used as given. What the script does:

- Creates the profile directory (mode 0700) and signs in with `claude auth login`, or stores an API key or token in `<profile>/api-key.env` (mode 0600) for the `api_key` method.
- **Links these items from your default profile into the new one** (only those that exist): `CLAUDE.md`, `settings.json`, `skills`, `agents`, `commands`, `rules`. So the target runs with your instructions, settings and hooks, and editing one of them from the target edits your default profile. To share less, edit the `SHARED=(...)` line at the top of the script before running it. Plugins, credentials, history and sessions are not shared.
- Writes a launcher (for example `~/.local/bin/claude-second`) that sets `CLAUDE_CONFIG_DIR` and loads the profile's key file, if any.
- Registers the profile in `~/.wingman/accounts.json` (id = the name without a leading `claude-`, so `claude-second` becomes `second`).

The wingman MCP server never reads credentials: it only runs the launcher named in the registry. `CLAUDE_CONFIG_DIR` is not a documented Claude Code setting, so treat profile isolation as working but unsupported.

The registry is a plain file (directory mode 0700, file mode 0600). You can edit it by hand:

```json
{
  "accounts": [
    {
      "id": "second",
      "label": "claude-second",
      "config_dir": "/home/<you>/.claude-second",
      "provider": "claude",
      "command": "/home/<you>/.local/bin/claude-second"
    }
  ]
}
```

`command` defaults to `claude` (use that for a profile signed in with `claude auth login` only). The caller's own profile is never a target. `WINGMAN_HOME` moves the state directory (default `~/.wingman`).

## 3. Your first run

Open a Claude Code session in a git repository (any branch, including `main`) and type:

```
/wingman:new-agent summarize this repository in five bullets
```

Claude picks the `readonly` preset, starts a run on a random eligible target, waits in the background and shows the report. You should see a run id, a status of `done` and the report text. A `readonly` run gets a detached worktree and cannot change your files; the skill calls `wingman_cleanup` afterwards to remove the worktree.

For a task that changes files, ask for it explicitly (for example "... and fix it"): the skill then uses the `edit` preset. The target commits on a run branch that you review and merge yourself; wingman never pushes or merges.

Claude is told to prefer wingman over its built-in Agent tool when you ask for a subagent, delegation or an independent review ("use a subagent to ..."). The plugin does this with the skill description and a `SessionStart` hook that prints a static instruction (`wingman/hooks/session-start.json`) into each session; the hook runs no other code. To avoid the hook, empty `hooks/hooks.json` in your installed copy of the plugin, or set `disableAllHooks` in your Claude Code settings (which turns off every hook, not only this one). It falls back to the built-in tool, and says so, when wingman is unavailable, the target is rate limited, or the task needs to run tests under `readonly`.

## Check your setup

`wingman doctor` checks the registry and the profiles. It reads local files only, changes nothing, and never prints credentials:

```sh
node <plugin dir>/wingman/bin/wingman doctor            # offline checks
node <plugin dir>/wingman/bin/wingman doctor --online   # also asks each profile who is signed in
node <plugin dir>/wingman/bin/wingman doctor --json     # machine-readable list of {id, level, message}
```

It checks the state directory and `accounts.json` (modes 0700 and 0600, valid JSON, no duplicate ids), each account's `config_dir` and launcher, the shared items `another-login.sh` links from your default profile, and the installed wingman plugin version of each profile.

- `[ok]`: fine (some are informational, such as an unshared item or a target without the plugin).
- `[warn]`: works, but worth a look (loose modes, a forked shared item, a version mismatch, no second account yet).
- `[fail]`: something is broken (missing `config_dir`, launcher not found or not executable, broken link, invalid registry). The exit code is 1 when there is a `fail`, 0 otherwise, 2 for bad arguments.

`--online` runs `auth status --json` for you and for each account (20 s timeout) and prints only whether it is signed in, the auth method, and whether the account differs from yours. A profile whose `CLAUDE_CONFIG_DIR` stopped taking effect shows up as `different account from the caller: no`. Emails and organisation ids are compared by hash and never printed.

The `add-account` skill walks through adding a second account and reading this output; `new-agent` runs the tasks.

## Presets, worktrees and branches

| | `readonly` (default) | `edit-files` | `edit` |
|---|---|---|---|
| Tools | Read, Glob, Grep, read-only git | plus Edit, Write, selected git commands; no `node`, `npm`, Agent or Skill | plus Skill, Agent, `node`, `npm` |
| Runs commands | no | no (only git and `date`) | yes, arbitrary code |
| Worktree | detached, no branch | run branch: `<your-branch>-wm-<run id>`, or `wingman/<run id>` when you are on `main` or another base branch | same as `edit-files` |
| Your checkout | never touched | never touched | never touched |

Every run in a git repository gets its own worktree cut from your current HEAD, so commit what the run needs first. Starting from a base branch is fine because the run works elsewhere. A detached HEAD is refused. Outside a git repository the run uses the directory as it is.

## Tools

The skill drives these; you can also call them directly.

| Tool | Purpose |
|---|---|
| `wingman_start` | start a run: `prompt` and `cwd` are required; `account`, `preset`, `model`, `max_turns`, `worktree`, `branch`, `lock_key`, `setup`, `allowed_tools` are optional. Omit `account` to get a random active target. Then run `bin/wingman-wait <run id>` and call `wingman_result` |
| `wingman_status` | state of a run, no report text |
| `wingman_result` | the final report, masked, in pages (`offset`, `limit`; default 4000, max 8000 characters): keep calling with `result_next_offset` until it is absent |
| `wingman_cancel` | stop a run |
| `wingman_list` | recent runs |
| `wingman_cleanup` | remove a run's worktree (`accept` refuses uncommitted changes); the run branch, when there is one, is kept |

Run state lives in `~/.wingman/runs/<id>/`. Do not read `events.jsonl`: it holds raw tool output.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No other active account is registered to run on` | empty registry, only the caller's own profile, or accounts whose status is not `active` | run `another-login.sh` for a second profile, or fix `~/.wingman/accounts.json` |
| `Unknown account "x". Registered accounts: ...` | the id is not in the registry | use one of the listed ids |
| `... is the caller's own profile` | you named your own account as the target | pick another account |
| the run ends `failed_no_report`, or the report says "Not logged in" | the target's login expired or its launcher cannot find its key | run `<launcher> auth status`; sign in again with `another-login.sh --force` |
| `Refusing to start a run on a detached HEAD` | HEAD is not on a branch | `git switch` to a branch |
| `Refusing to start a run on the base branch ... without a worktree` | `worktree: false` on `main` | drop `worktree: false` |
| status `rate_limited` | the target hit its usage limit | wait for the reset time in the report, or start a new run on another account |
| status `needs_caller` | the run changed your base branch, branch ref, repo config or git hooks, or needs a plugin change | inspect with `git log --oneline` and `git diff`; start a new run |
| `wingman_cleanup` refuses | the run is still running, or the worktree has uncommitted changes | cancel it, or commit or discard the changes (`action: discard`) |

## Where wingman keeps data

- State lives in `~/.wingman`, or in `WINGMAN_HOME` when set. Directories are created with mode 0700 and files with 0600.
- `accounts.json` is the account registry.
- `runs/<id>/` holds `meta.json`, `result.md` and `events.jsonl`. `events.jsonl` is the raw event stream of the agent and may contain sensitive values: wingman never returns it, and you should not read or share it.
- Automatic trimming, and nothing else:
  - when a run finishes, `events.jsonl` is cut to its last 20 MiB (whole lines only);
  - when a top-level wingman server starts, `events.jsonl` of runs that ended more than 14 days ago is deleted;
  - when a top-level wingman server starts, the worktree of a run is removed if the run is over (finished more than a day ago, or found dead), its worktree has no uncommitted changes and no process of the run is still alive.
- Run directories, `meta.json` and `result.md` are **not** deleted automatically. `wingman gc` removes them on demand; it is manual for now, nothing runs it for you:

  ```sh
  node <plugin dir>/wingman/bin/wingman gc --older-than-days 30
  node <plugin dir>/wingman/bin/wingman gc --dry-run   # same counts, changes nothing
  ```

  It deletes the whole directory of runs that are over and finished more than N days ago (default 30), never a run that is still running (a dead one is first ended as `failed_no_report`), and keeps a run whose worktree still exists. It also prunes orphan worktrees as the server does at start and removes lock files whose owner process is gone or whose run no longer exists. It never deletes git branches. It prints counts only and exits 0 (2 on bad arguments).
- `worktrees/` holds one git worktree per run. `wingman_cleanup` (`accept` or `discard`) removes the worktree and releases its lock. It keeps the `wingman/<runid>` branch in your repository: delete it yourself with `git branch -D` when you no longer need it.
- `locks/` holds one small lock file per `lock_key` in use. It is removed when the run is cleaned up, and a lock left by a dead process is reclaimed the next time the same key is used.

## Limits

- The deny rules are advisory: the `edit` preset allows `node` and `npm`, which run arbitrary code; `edit-files` allows no command except git and `date`, but it still commits and edits files, so it is not a sandbox either. `setup` is an arbitrary shell command run as your user, outside the presets. Neither is a sandbox.
- A run that changes your base branch, your branch ref, the repository's local git config or its git hooks ends as `needs_caller`. This is an after-the-fact check, not prevention.
- The prompt reaches the agent over stdin, so it does not show in the process list. The appended system prompt (the guard text) is still a command-line argument; it is static and not secret.
- On macOS the process checks use `ps` and have had little real-world use (see Requirements).
- A run cannot be resumed; start a new one. There is no automatic failover when an account is rate limited.
- Wingman relies on `--strict-mcp-config` and the stream-json output of Claude Code; other Claude Code versions than the tested one may behave differently.

## More

- `DESIGN.md`: concepts, lifecycle and guardrails.
- `ROADMAP.md`: what is done and planned. `docs/history/`: the original build notes.
- `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`.
- `CODE_OF_CONDUCT.md`, `docs/RELEASING.md`.

## License

MIT, see `LICENSE`.
