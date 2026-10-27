import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

export type Level = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  level: Level;
  message: string;
}

export type ExecFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string }>;

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  exec: ExecFn;
}

/** Mirrors `SHARED` in another-login.sh. */
export const SHARED_ITEMS = [
  'CLAUDE.md',
  'settings.json',
  'skills',
  'agents',
  'commands',
  'rules',
  'plugins',
];
const PLUGIN_KEY = 'wingman@wingman-marketplace';
const ONLINE_TIMEOUT_MS = 20_000;
const DOCTOR_USAGE = 'usage: wingman doctor [--online] [--json]';
const AUTH_METHOD = /^[A-Za-z0-9_.-]{1,40}$/;

interface RegistryAccount {
  id: string;
  config_dir: string;
  command: string;
  status?: string;
}

const defaultExec: ExecFn = (file, args, { env, timeoutMs }) =>
  new Promise((res, rej) => {
    execFile(
      file,
      args,
      { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err ? rej(err) : res({ stdout })),
    );
  });

export function defaultDeps(): DoctorDeps {
  return { env: process.env, homeDir: homedir(), exec: defaultExec };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function octal(m: number): string {
  return m.toString(8).padStart(4, '0');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function checkState(stateDir: string, results: CheckResult[]): RegistryAccount[] | undefined {
  if (!isDir(stateDir)) {
    results.push({
      id: 'state.dir',
      level: 'warn',
      message: `state directory ${stateDir} does not exist yet (the server creates it on first start)`,
    });
    return undefined;
  }
  const dirMode = mode(stateDir);
  results.push(
    (dirMode & 0o077) === 0
      ? { id: 'state.dir', level: 'ok', message: `state directory ${stateDir} has mode 0700` }
      : {
          id: 'state.dir',
          level: 'warn',
          message: `state directory ${stateDir} has mode ${octal(dirMode)}, expected 0700 (fix: chmod 700)`,
        },
  );

  const file = join(stateDir, 'accounts.json');
  if (!exists(file)) {
    results.push({
      id: 'registry.file',
      level: 'warn',
      message: 'accounts.json does not exist yet (no account registered)',
    });
    return undefined;
  }
  const fileMode = mode(file);
  results.push(
    (fileMode & 0o077) === 0
      ? { id: 'registry.mode', level: 'ok', message: 'accounts.json has mode 0600' }
      : {
          id: 'registry.mode',
          level: 'warn',
          message: `accounts.json has mode ${octal(fileMode)}, expected 0600 (fix: chmod 600)`,
        },
  );

  let json: unknown;
  try {
    json = readJson(file);
  } catch {
    results.push({
      id: 'registry.parse',
      level: 'fail',
      message: 'accounts.json is not valid JSON',
    });
    return undefined;
  }
  const list = (json as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(list)) {
    results.push({
      id: 'registry.parse',
      level: 'fail',
      message: 'accounts.json has no "accounts" array',
    });
    return undefined;
  }
  const accounts: RegistryAccount[] = [];
  for (const item of list) {
    const a = item as Record<string, unknown> | null;
    if (
      a === null ||
      typeof a !== 'object' ||
      typeof a.id !== 'string' ||
      a.id === '' ||
      typeof a.config_dir !== 'string' ||
      a.config_dir === ''
    ) {
      results.push({
        id: 'registry.parse',
        level: 'fail',
        message: 'accounts.json has an entry without a valid id and config_dir',
      });
      return undefined;
    }
    accounts.push({
      id: a.id,
      config_dir: a.config_dir,
      command: typeof a.command === 'string' && a.command !== '' ? a.command : 'claude',
      ...(typeof a.status === 'string' && a.status !== '' ? { status: a.status } : {}),
    });
  }
  const ids = accounts.map((a) => a.id);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length > 0) {
    results.push({
      id: 'registry.parse',
      level: 'fail',
      message: `accounts.json has duplicate account ids: ${dupes.join(', ')}`,
    });
    return accounts;
  }
  results.push({
    id: 'registry.parse',
    level: 'ok',
    message: `accounts.json parses, ${accounts.length} account(s), no duplicate ids`,
  });
  return accounts;
}

function resolveCommand(command: string, pathVar: string, cwd: string): string | undefined {
  const candidates = command.includes('/')
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : pathVar
        .split(delimiter)
        .filter((d) => d !== '')
        .map((d) => join(d, command));
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // not here
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function checkAccount(
  account: RegistryAccount,
  callerDir: string,
  defaultDir: string,
  deps: DoctorDeps,
  results: CheckResult[],
): void {
  const p = `account.${account.id}`;
  const dirOk = isDir(account.config_dir);
  results.push(
    dirOk
      ? { id: `${p}.config_dir`, level: 'ok', message: `${account.id}: config_dir exists` }
      : {
          id: `${p}.config_dir`,
          level: 'fail',
          message: `${account.id}: config_dir ${account.config_dir} does not exist`,
        },
  );

  const found = resolveCommand(account.command, deps.env.PATH ?? '', process.cwd());
  if (found === undefined) {
    results.push({
      id: `${p}.command`,
      level: 'fail',
      message: `${account.id}: command "${account.command}" not found`,
    });
  } else if (!isExecutable(found)) {
    results.push({
      id: `${p}.command`,
      level: 'fail',
      message: `${account.id}: command ${found} is not executable (fix: chmod +x)`,
    });
  } else {
    results.push({
      id: `${p}.command`,
      level: 'ok',
      message: `${account.id}: command ${found} is executable`,
    });
  }

  if (canonical(account.config_dir) === callerDir) {
    results.push({
      id: `${p}.self`,
      level: 'ok',
      message: `${account.id}: info: this is the profile you are running in; it is skipped when you delegate from it and used when you delegate from another profile`,
    });
  }

  const status = account.status ?? 'active';
  results.push({
    id: `${p}.status`,
    level: 'ok',
    message: `${account.id}: status ${status}${status === 'active' || status === 'disabled' ? '' : ' (unknown value, treated as disabled)'}`,
  });

  if (dirOk && canonical(account.config_dir) !== canonical(defaultDir)) {
    checkShared(account, defaultDir, results);
  }
  if (dirOk) checkPlugin(account, results);
}

function checkShared(account: RegistryAccount, defaultDir: string, results: CheckResult[]): void {
  for (const item of SHARED_ITEMS) {
    const source = join(defaultDir, item);
    if (!exists(source)) continue;
    const id = `account.${account.id}.shared.${item}`;
    const target = join(account.config_dir, item);
    let st;
    try {
      st = lstatSync(target);
    } catch {
      results.push({
        id,
        level: 'ok',
        message: `${account.id}: ${item} absent (not shared, fine)`,
      });
      continue;
    }
    if (!st.isSymbolicLink()) {
      const migrate =
        item === 'plugins' && st.isDirectory()
          ? `. To share it, run: mv ${target} ${target}.bak && ln -s ${source} ${target} (the backup can be deleted after checking that the plugins still work)`
          : '';
      results.push({
        id,
        level: 'warn',
        message: `${account.id}: ${item} is forked, no longer shared with the default profile${migrate}`,
      });
      continue;
    }
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      results.push({ id, level: 'fail', message: `${account.id}: ${item} is a broken link` });
      continue;
    }
    results.push(
      real === canonical(source)
        ? { id, level: 'ok', message: `${account.id}: ${item} is linked to the default profile` }
        : {
            id,
            level: 'warn',
            message: `${account.id}: ${item} links somewhere other than the default profile`,
          },
    );
  }
}

function checkPlugin(account: RegistryAccount, results: CheckResult[]): void {
  const id = `account.${account.id}.plugin`;
  const file = join(account.config_dir, 'plugins', 'installed_plugins.json');
  if (!exists(file)) {
    results.push({
      id,
      level: 'ok',
      message: `${account.id}: wingman plugin not installed (targets do not need it)`,
    });
    return;
  }
  let version: string | undefined;
  try {
    const entries = (readJson(file) as { plugins?: Record<string, unknown> } | null)?.plugins?.[
      PLUGIN_KEY
    ];
    if (Array.isArray(entries)) {
      for (const e of entries) {
        const v = (e as { version?: unknown } | null)?.version;
        if (typeof v === 'string') {
          version = v;
          break;
        }
      }
    }
  } catch {
    results.push({
      id,
      level: 'warn',
      message: `${account.id}: installed_plugins.json is not valid JSON`,
    });
    return;
  }
  if (version === undefined) {
    results.push({
      id,
      level: 'ok',
      message: `${account.id}: wingman plugin not installed (targets do not need it)`,
    });
  } else if (version === pkg.version) {
    results.push({
      id,
      level: 'ok',
      message: `${account.id}: wingman plugin ${version} matches the running server`,
    });
  } else {
    results.push({
      id,
      level: 'warn',
      message: `${account.id}: wingman plugin ${version} differs from the running server ${pkg.version} (run: claude plugin update)`,
    });
  }
}

interface Auth {
  signedIn: boolean;
  method: string;
  identity: string | undefined;
}

async function authStatus(
  command: string,
  deps: DoctorDeps,
): Promise<{ auth: Auth } | { error: string }> {
  let stdout: string;
  try {
    ({ stdout } = await deps.exec(command, ['auth', 'status', '--json'], {
      env: deps.env,
      timeoutMs: ONLINE_TIMEOUT_MS,
    }));
  } catch (err) {
    const e = err as { killed?: boolean; code?: unknown };
    return {
      error:
        e.killed === true
          ? 'timed out after 20 s'
          : `exited with an error${typeof e.code === 'number' ? ` (code ${e.code})` : ''}`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { error: 'returned output that is not JSON' };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { error: 'returned output that is not a JSON object' };
  }
  const o = json as Record<string, unknown>;
  const method =
    typeof o.authMethod === 'string' && AUTH_METHOD.test(o.authMethod) ? o.authMethod : 'unknown';
  const identity =
    typeof o.email === 'string' && typeof o.orgId === 'string'
      ? createHash('sha256').update(`${o.email}\0${o.orgId}`).digest('hex')
      : undefined;
  return { auth: { signedIn: o.loggedIn === true, method, identity } };
}

async function checkOnline(
  accounts: RegistryAccount[],
  deps: DoctorDeps,
  results: CheckResult[],
): Promise<void> {
  const caller = await authStatus('claude', deps);
  if ('error' in caller) {
    results.push({
      id: 'online.caller',
      level: 'warn',
      message: `caller: claude auth status ${caller.error}`,
    });
  } else {
    results.push({
      id: 'online.caller',
      level: caller.auth.signedIn ? 'ok' : 'warn',
      message: `caller: signed in ${caller.auth.signedIn ? 'yes' : 'no'}, authMethod ${caller.auth.method}`,
    });
  }
  const callerIdentity = 'auth' in caller ? caller.auth.identity : undefined;

  for (const account of accounts) {
    const id = `online.${account.id}`;
    const r = await authStatus(account.command, deps);
    if ('error' in r) {
      results.push({ id, level: 'warn', message: `${account.id}: auth status ${r.error}` });
      continue;
    }
    const { signedIn, method, identity } = r.auth;
    const different =
      identity === undefined || callerIdentity === undefined
        ? 'unknown'
        : identity !== callerIdentity
          ? 'yes'
          : 'no';
    results.push({
      id,
      level: signedIn && different !== 'no' ? 'ok' : 'warn',
      message: `${account.id}: signed in ${signedIn ? 'yes' : 'no'}, authMethod ${method}, different account from the caller: ${different}${different === 'no' ? ' (CLAUDE_CONFIG_DIR of this profile may not take effect)' : ''}`,
    });
  }
}

export async function runChecks(online: boolean, deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const stateDir = deps.env.WINGMAN_HOME || join(deps.homeDir, '.wingman');
  const defaultDir = deps.env.CLAUDE_DEFAULT_DIR || join(deps.homeDir, '.claude');
  const callerDir = canonical(deps.env.CLAUDE_CONFIG_DIR || join(deps.homeDir, '.claude'));

  const accounts = checkState(stateDir, results) ?? [];
  const others = accounts.filter((a) => canonical(a.config_dir) !== callerDir);
  if (others.length === 0) {
    results.push({
      id: 'registry.accounts',
      level: 'warn',
      message: "no account other than the caller's own is registered (run another-login.sh)",
    });
  }
  for (const account of accounts) checkAccount(account, callerDir, defaultDir, deps, results);
  if (online) await checkOnline(accounts, deps, results);
  return results;
}

export async function doctorCommand(args: string[], deps: DoctorDeps): Promise<number> {
  let online = false;
  let json = false;
  for (const a of args) {
    if (a === '--online') online = true;
    else if (a === '--json') json = true;
    else {
      process.stderr.write(`wingman doctor: unexpected argument ${a}\n${DOCTOR_USAGE}\n`);
      return 2;
    }
  }
  const results = await runChecks(online, deps);
  const count = (l: Level): number => results.filter((r) => r.level === l).length;
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const r of results) process.stdout.write(`[${r.level}] ${r.message}\n`);
    process.stdout.write(
      `wingman doctor: ${count('ok')} ok, ${count('warn')} warn, ${count('fail')} fail\n`,
    );
  }
  return count('fail') > 0 ? 1 : 0;
}
