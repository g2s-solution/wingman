---
name: remove-account
description: Remove a second Claude account from wingman, either only from wingman's list (the profile is kept) or the whole profile with its credentials. Use when the user wants to remove, unregister, delete or log out an account, or to stop delegating to it.
---

# remove-account

Remove a Claude account that wingman can delegate to. You explain and run the safe parts; anything that deletes credentials is the user's own command.

## Rules

- Never print, send or write sensitive values: tokens (Bearer, JWT, PAT, API keys), passwords, secrets, private keys, credentials in URLs, `.env` values, PII. Do not cat/Read files that may hold them.
- Never read a profile's credential files or `api-key.env`.
- Never run `another-logout.sh` and never pass `--yes` to it: it deletes credentials, so the user runs it.

## 1. Pick the mode

Ask which one the user wants, unless it is already clear. First identify the account: `${CLAUDE_PLUGIN_ROOT}/bin/wingman accounts list` (the id is the first column).

- **Pause only** (nothing deleted, easy to undo): `${CLAUDE_PLUGIN_ROOT}/bin/wingman accounts disable ID`; `enable` brings it back.
- **Unregister, keep the profile**: the account leaves wingman's list, the profile directory, its credentials and the launcher stay, so the user can still run it by hand or register it again.
- **Remove the whole profile**: registration, launcher and the profile directory with its credentials are deleted.

## 2. Unregister, keep the profile

```sh
${CLAUDE_PLUGIN_ROOT}/bin/wingman accounts remove ID
```

Without `--yes` it only shows what it would do. Show that to the user, and run it again with `--yes` once they agree. It deletes nothing but the registry entry (paths only, no credentials). To register the profile again later: `${CLAUDE_PLUGIN_ROOT}/bin/wingman accounts add --id ID --label NAME --config-dir DIR --command LAUNCHER`.

## 3. Remove the whole profile

The user runs this in their own terminal, from a checkout of the wingman repository (`another-logout.sh` is not shipped in the plugin):

```sh
./another-logout.sh [--yes] [--keep-dir] <name>
```

It prints what it will delete and asks for confirmation. It removes the wingman registration, the launcher made by `another-login.sh` and, unless `--keep-dir`, the profile directory with its credentials; the items linked from the default profile are unlinked, never deleted. It refuses the default profile, its parents and children, and `$HOME`. Wait until the user says it is done; do not run it for them.

## 4. Check

```sh
${CLAUDE_PLUGIN_ROOT}/bin/wingman accounts list
```

The account must be gone. Mention that the Claude subscription or API key itself is untouched: revoking an API key or signing out of the subscription is done on the provider's side.
