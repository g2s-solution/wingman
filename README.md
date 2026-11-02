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

Restart the session. The plugin is needed in each profile you delegate from (profiles that share `plugins` get it together); the target of a run loads no MCP servers. To update later:

```bash
claude plugin marketplace update wingman-marketplace && claude plugin update wingman@wingman-marketplace
```

Claude Code updates a plugin only when its version number changes (see `CHANGELOG.md`).

## 2. Create the second profile

Clone this repository (the login script is not part of the plugin) and run:

```bash
./another-login.sh [--method claudeai|console|api_key|api_key_unverified] [config-dir]
```

A bare name such as `claude-second` becomes `~/.claude-second`; a value containing `/` or `~` is used as given. What the script does:

- Creates the profile directory (mode 0700) and signs in with `claude auth login`, or stores an API key or token in `<profile>/api-key.env` (mode 0600) for the `api_key` method. `api_key_unverified` does the same and every other step, but accepts any non-empty key (no format check) and skips the sign-in check at the end so the key can be activated later; check it then with `<launcher> auth status --text`. Wingman registers the profile either way, so it may show as not signed in until the key works.
- **Links these items from your default profile into the new one** (only those that exist): `CLAUDE.md`, `settings.json`, `skills`, `agents`, `commands`, `rules`, `plugins`. So the target runs with your instructions, settings, hooks and plugins, and editing one of them from the target edits your default profile. To share less, edit the `SHARED=(...)` line at the top of the script before running it. Credentials, `.claude.json`, history and sessions are not shared. If the new profile already has a real `plugins` directory the script skips it and prints the two commands to migrate it (see [Delegate in both directions](#delegate-in-both-directions-role-swap)).
- Writes a launcher (for example `~/.local/bin/claude-second`) that sets `CLAUDE_CONFIG_DIR` and loads the profile's key file, if any.
- Registers the profile in `~/.wingman/accounts.json` (id = the name without a leading `claude-`, so `claude-second` becomes `second`).

To remove a profile again, run `./another-logout.sh [--yes] [--keep-dir] <config-dir>`. It shows what it will remove and asks first; it unregisters the account from wingman, deletes the launcher this script made and (unless `--keep-dir`) the profile directory with its credentials. It refuses the default profile, and the shared items it linked are unlinked, never deleted.

The wingman MCP server never reads credentials: it only runs the launcher named in the registry. `CLAUDE_CONFIG_DIR` is not a documented Claude Code setting, so treat profile isolation as working but unsupported.

The registry is a plain file (directory mode 0700, file mode 0600). `another-login.sh` writes it through `wingman accounts add --upsert`, and that CLI is the normal way to change it (see "Manage accounts" below). The format, if you ever need to read or edit it by hand:

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

`command` defaults to `claude` (use that for a profile signed in with `claude auth login` only). The caller's own profile may be registered, but it is never chosen as a target from itself. `WINGMAN_HOME` moves the state directory (default `~/.wingman`).

### Manage accounts

Run these in a terminal: `node <plugin dir>/wingman/bin/wingman accounts <command>`.

```sh
wingman accounts list [--json]            # id, label, provider, models, status, limited_until, runs by status, config_dir, command; marks your own profile
wingman accounts add --id ID --config-dir DIR [--label L] [--command CMD] [--provider P]
                     [--haiku M] [--sonnet M] [--opus M] [--upsert]
wingman accounts disable ID               # status disabled: never picked, and refused when named
wingman accounts enable ID                # back to active
wingman accounts mark-limited ID --until T   # T: ISO time with Z or an offset, a date (UTC) or epoch seconds
wingman accounts clear-limited ID         # make a limited account selectable again
wingman accounts remove ID --yes          # registry entry only; the profile directory and credentials are not touched
```

`add` needs an absolute `--config-dir` (a leading `~` is expanded), refuses a duplicate id unless `--upsert` (which keeps fields you set by hand, such as `status`). Registering your own profile is allowed and prints a note: it is skipped when you delegate from it and used when you delegate from another profile. `remove` without `--yes` only prints what it would do and exits 2. Exit codes: 0 ok, 2 usage or validation error, 1 unexpected error. The commands never read or write credentials.

**Model tiers.** `--haiku`, `--sonnet` and `--opus` set the model this account uses for each tier (for example a Codex or OpenCode model name; `-` clears a tier; an `--upsert` without these flags keeps them). When `wingman_start` is called with `model: "sonnet"` (or `haiku`, `opus`) the account's model for that tier is used; a tier that is not set, or any other value, is passed to the provider unchanged, and an omitted `model` leaves the provider default. `wingman_accounts` shows each account's `models`, so Claude can see what a tier means before it picks.

**Other providers (Codex).** An account with `--provider codex` runs `codex exec` instead of Claude Code:

```sh
wingman accounts add --id codex1 --config-dir ~/.codex --provider codex --sonnet <codex model>
```

`--command` defaults to the provider name (`codex`); `--config-dir` becomes `CODEX_HOME`, so use a dedicated profile, not one you also use for something else. Log in with `codex login` under that `CODEX_HOME` first. Differences from a Claude account, all deliberate:

- Presets map to Codex sandboxes: `readonly` is `read-only`; `edit-files` and `edit` are `workspace-write`. Codex cannot commit inside a git worktree, so wingman commits the changes on the run branch itself after the run (the report says so). `edit` adds nothing over `edit-files` for Codex.
- The guardrail text is prepended to the prompt instead of being a system prompt, and there is no tool deny list: the sandbox is the real boundary. A `read-only` sandbox can still read files under `$HOME`, including that profile's own login file. Treat a Codex run as less contained than a Claude run. When wingman commits for the agent it runs git with hooks, fsmonitor and signing disabled, and it skips the commit (leaving the changes in the worktree and saying so) if the staged changes include symlinks, nested repositories or files that look like credentials; a process the agent left running in the background could still touch the worktree while wingman commits.
- `allowed_tools` and `max_turns` are refused (Codex has no such flags); the run is bounded by its time limit.
- User config and rules are not loaded (`--ignore-user-config`, `--ignore-rules`), so MCP servers and hooks from that profile do not run.
- `wingman doctor` checks only that the directory and command exist; the shared-item, plugin and sign-in checks are for Claude profiles.
- `events.jsonl` keeps Codex's raw output (command output, file contents) unmasked on disk like Claude's; tools never return it, and `wingman gc` prunes it.

**Other providers (OpenCode).** An account with `--provider opencode` runs `opencode run --format json --standalone`:

```sh
wingman accounts add --id oc1 --config-dir ~/.wingman-opencode --provider opencode --sonnet <provider/model>
```

`--config-dir` is a directory that wingman maps to four XDG roots for the run (`config`, `data`, `state`, `cache` inside it), so the profile has its own login, settings and MCP servers and never touches your normal OpenCode setup. Log in once with `XDG_CONFIG_HOME=<dir>/config XDG_DATA_HOME=<dir>/data XDG_STATE_HOME=<dir>/state XDG_CACHE_HOME=<dir>/cache opencode auth login`. Model names are `provider/model` (see `opencode models`); name one with `--sonnet` and so on, or `model` in `wingman_start`; OpenCode's own default model may not work for your plan. Differences from a Claude account:

- OpenCode has no sandbox; wingman gives each run a permission config (through `OPENCODE_CONFIG_CONTENT`, never on disk). It denies web fetches, nested agents (`task`) and any path outside the worktree (`external_directory`), and allows only the git commands of the preset in `bash`: `readonly` reads (`git status|log|diff|show`, `date`); `edit-files` also edits files and runs `git add|commit|mv|rm|restore|rev-parse|ls-files`; `edit` also runs `node` and `npm` (never `npm publish` or a global install). Chained commands are judged one by one, and the last matching rule wins, so the refusals come last. OpenCode commits for itself, so wingman does not.
- The guardrail text is prepended to the prompt (no system-prompt flag). `allowed_tools` and `max_turns` are refused.
- A run's report is its last text message; a run that ends without a finished step is `failed_no_report`; an error event (or HTTP 429) ends it as `failed` or `rate_limited`.
- `wingman doctor` checks only the directory and the command. `events.jsonl` keeps the raw output on disk like the other providers.

When a run ends `rate_limited`, wingman marks its account `rate_limited` until the reset time the run reported (`limited_until`). A limited account is skipped when Claude does not name one, and refused when it does; once the time has passed it counts as active again, with no job running. The `rate_limited` answer names the other active accounts, if any, and Claude (not wingman) decides whether to retry on one. `mark-limited` and `clear-limited` set or lift the state by hand. `wingman doctor` lists limited accounts as warnings and does not fail because of them.

Claude can list the accounts (with their limited state and run counts per outcome) through the read-only `wingman_accounts` tool, but no tool adds, changes or removes one: an entry's `command` is run by wingman, so only you, in a terminal, can change it.

### Delegate in both directions (role swap)

Two profiles, for example your default `~/.claude` and `~/.claude-second`, can each delegate to the other.

1. Register every profile you want to delegate to or from. For the default profile, run this from any profile: `wingman accounts add --id main --label default --config-dir ~/.claude --command claude`. The registry is shared, and each profile skips itself when choosing a target, so from `second` only `main` is picked and from `main` only `second`.
2. Install the wingman plugin in each profile that should delegate. With `plugins` linked (next point) one install covers all.
3. `another-login.sh` links `plugins`, `skills`, `settings.json` and the rest from the default profile into the new one, so every profile has the same plugins, skills and settings. This means that installing or updating a plugin in one profile affects all of them, and a run in flight can fail if a plugin is updated meanwhile. `.claude.json`, credentials, history and sessions stay per profile.
4. To migrate an existing second profile that has its own `plugins` directory, run (with your paths):

   ```sh
   mv ~/.claude-second/plugins ~/.claude-second/plugins.bak && ln -s ~/.claude/plugins ~/.claude-second/plugins
   ```

   `wingman doctor` prints these two commands with the real paths for each profile whose `plugins` is a real directory. Nothing moves automatically; delete the backup once the plugins work.

A delegated run can never delegate further: see "No recursion" in `DESIGN.md`.

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

It checks the state directory and `accounts.json` (modes 0700 and 0600, valid JSON, no duplicate ids), each account's `config_dir` and launcher, the shared items `another-login.sh` links from your default profile (including `plugins`), and the installed wingman plugin version of each profile.

- `[ok]`: fine (some are informational, such as an unshared item, a target without the plugin, or an account that is the profile you are running in).
- `[warn]`: works, but worth a look (loose modes, a forked shared item, a version mismatch, no second account yet).
- `[fail]`: something is broken (missing `config_dir`, launcher not found or not executable, broken link, invalid registry). The exit code is 1 when there is a `fail`, 0 otherwise, 2 for bad arguments.

`--online` runs `auth status --json` for you and for each account (20 s timeout) and prints only whether it is signed in, the auth method, and whether the account differs from yours. A profile whose `CLAUDE_CONFIG_DIR` stopped taking effect shows up as `different account from the caller: no`. Emails and organisation ids are compared by hash and never printed.

The `add-account` skill walks through adding a second account and reading this output; `remove-account` pauses, unregisters or removes one; `new-agent` runs the tasks.

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
| `wingman_start` | start a run: `prompt` and `cwd` are required; `account`, `preset`, `model`, `max_turns`, `worktree`, `branch`, `lock_key`, `setup`, `allowed_tools` are optional. Omit `account` to get a random active target. `max_turns` defaults by preset (`readonly` 40, `edit-files` 100, `edit` 200); an explicit value wins, up to 1000. Unknown parameters are rejected with the key named. Then run `bin/wingman-wait <run id>` and call `wingman_result` |
| `wingman_status` | state of a run, no report text; a `partial` run with denied commands gets a `hint` naming them (the tool, and for `Bash` the first two masked words of the command) |
| `wingman_result` | the final report, masked, in pages (`offset`, `limit`; default 4000, max 8000 characters): keep calling with `result_next_offset` (see `pages_left` and `next`) until it is absent. On a running run it says `still running` and hints to wait with `bin/wingman-wait` |
| `wingman_cancel` | stop a run |
| `wingman_list` | recent runs |
| `wingman_accounts` | the registered accounts: id, label, status (with `limited_until` while limited), `is_caller`, provider, `runs` by status (read-only; no command or paths; accounts are changed only with the `wingman accounts` CLI) |
| `wingman_cleanup` | remove a run's worktree (`accept` refuses uncommitted changes); the run branch, when there is one, is kept. `accept` on a run with a branch also returns `run_branch`, a `diff_stat` (never the diff) and a note to review before merging; on a readonly run `accept` and `discard` are the same |

Run state lives in `~/.wingman/runs/<id>/`. Do not read `events.jsonl`: it holds raw tool output.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No other active account is registered to run on` | empty registry, only the caller's own profile, or accounts whose status is not `active` | run `another-login.sh` for a second profile, or check `wingman accounts list` and `wingman accounts enable <id>` |
| `Unknown account "x". Registered accounts: ...` | the id is not in the registry | use one of the listed ids |
| `... is the caller's own profile` | you named your own account as the target | pick another account |
| the run ends `failed_no_report`, or the report says "Not logged in" | the target's login expired or its launcher cannot find its key | run `<launcher> auth status`; sign in again with `another-login.sh --force` |
| `Refusing to start a run on a detached HEAD` | HEAD is not on a branch | `git switch` to a branch |
| `Refusing to start a run on the base branch ... without a worktree` | `worktree: false` on `main` | drop `worktree: false` |
| status `rate_limited` | the target hit its usage limit | the account is marked limited until the reset time; the answer lists other active accounts: start a new run on one of them, or wait |
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
- To delete everything wingman stored, make sure no run is active (`wingman_cleanup` or cancel them first), remove the worktrees with `git worktree remove --force <path>` (or `git worktree prune` after deleting the directory), then `rm -rf ~/.wingman` (or `$WINGMAN_HOME`). The `wingman/<runid>` branches stay in your repositories until you delete them. Removing `accounts.json` unregisters your accounts, so run the add-account setup again afterwards.

## Limits

- The deny rules are advisory: the `edit` preset allows `node` and `npm`, which run arbitrary code; `edit-files` allows no command except git and `date`, but it still commits and edits files, so it is not a sandbox either. `setup` is an arbitrary shell command run as your user, outside the presets. Neither is a sandbox.
- A run that changes your base branch, your branch ref, the repository's local git config or its git hooks ends as `needs_caller`. This is an after-the-fact check, not prevention.
- The prompt reaches the agent over stdin, so it does not show in the process list. The appended system prompt (the guard text) is still a command-line argument; it is static and not secret.
- On macOS the process checks use `ps` and have had little real-world use (see Requirements).
- A run cannot be resumed; start a new one. There is no automatic failover when an account is rate limited: the answer names the alternatives and you decide.
- Wingman relies on `--strict-mcp-config` and the stream-json output of Claude Code; other Claude Code versions than the tested one may behave differently.

## More

- `DESIGN.md`: concepts, lifecycle and guardrails.
- `ROADMAP.md`: what is done and planned. `docs/history/`: the original build notes.
- `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`.
- `CODE_OF_CONDUCT.md`, `docs/RELEASING.md`.

## License

MIT, see `LICENSE`.
