---
name: add-account
description: Set up a second Claude account for wingman. Use when the user wants to add, register or check a second account, or asks why a target account does not work.
---

# add-account

Guide the user through adding a second Claude account that wingman can hand work to. You guide; the user signs in. Never do the login yourself.

## Rules

- Never print, send or write sensitive values: tokens (Bearer, JWT, PAT, API keys), passwords, secrets, private keys, credentials in URLs, `.env` values, PII. Do not cat/Read files that may hold them.
- Never enter, ask for or accept a password, token or API key in the chat. Never read a profile's credential files or `api-key.env`.

## 1. The user signs in

Signing in needs the user's own credentials, so the user runs this in their own terminal, from a checkout of the wingman repository (`another-login.sh` is not shipped in the plugin):

```sh
./another-login.sh [--method claudeai|console|api_key] <name>
```

Wait until they say it is done. Do not run it for them.

## 2. Check the registry and the profile

The CLI is `${CLAUDE_PLUGIN_ROOT}/bin/wingman`. Run:

```sh
${CLAUDE_PLUGIN_ROOT}/bin/wingman accounts list
${CLAUDE_PLUGIN_ROOT}/bin/wingman doctor
```

(`accounts` may arrive in the same release as `doctor`; if it is missing, skip it and use `doctor` alone.) Explain every `[warn]` and `[fail]` line in plain words with its fix:

- `config_dir does not exist` (fail): the profile directory is gone; run `another-login.sh` again.
- `command ... not found` or `not executable` (fail): the launcher is missing or lost its execute bit; `chmod +x` it or re-run `another-login.sh`.
- `broken link` (fail): a shared item points at a file that no longer exists in the default profile; re-run `another-login.sh --force`.
- `forked, no longer shared` (warn): the profile has its own copy of a file that was meant to be shared. Harmless; sharing is optional.
- `mode ... expected 0700/0600` (warn): `chmod 700` the state directory, `chmod 600` `accounts.json`.
- `no account other than the caller's own` (warn): nothing to delegate to yet; finish step 1.
- `plugin ... differs` (warn): update the plugin in that profile; targets do not need it.

## 3. Confirm the login

```sh
${CLAUDE_PLUGIN_ROOT}/bin/wingman doctor --online
```

This runs `auth status` for the caller and each account and prints only: signed in yes or no, the auth method, and whether the account differs from the caller. Good is `signed in yes` and `different account from the caller: yes`. `no` means the profile is not isolated (it reports the caller's account): re-check that its launcher sets `CLAUDE_CONFIG_DIR`. `signed in no` means the user should run `another-login.sh --force <name>`.

## 4. Disable or remove

- Pause an account: `${CLAUDE_PLUGIN_ROOT}/bin/wingman accounts disable ID` (`enable` brings it back).
- Remove it from the registry: `${CLAUDE_PLUGIN_ROOT}/bin/wingman accounts remove ID`. Say what it does and does not delete as the command reports it; deleting the profile directory is the user's own decision.
