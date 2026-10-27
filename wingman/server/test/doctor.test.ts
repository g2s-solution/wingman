import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeRunCli } from '../src/cli.js';
import { defaultDeps, type CheckResult, type DoctorDeps, type ExecFn } from '../src/doctor.js';
import pkg from '../package.json' with { type: 'json' };
import { tmp } from './helpers.js';

let root: string;
let home: string;
let defaultDir: string;
let out: string[];
let err: string[];

const EMAIL = ['someone', 'example.test'].join('@');
const ORG = ['org', '1234abcd'].join('-');
const TOKEN = ['sk', 'ant', 'fakefakefakefake'].join('-');

beforeEach(() => {
  root = tmp('doctor');
  home = join(root, 'state');
  defaultDir = join(root, 'default');
  mkdirSync(defaultDir);
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function launcher(name: string, executable = true): string {
  const path = join(root, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, executable ? 0o755 : 0o644);
  return path;
}

function profile(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRegistry(accounts: unknown[], dirMode = 0o700, fileMode = 0o600): void {
  mkdirSync(home, { recursive: true });
  chmodSync(home, dirMode);
  const file = join(home, 'accounts.json');
  writeFileSync(file, JSON.stringify({ accounts }));
  chmodSync(file, fileMode);
}

function acct(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    label: id,
    config_dir: profile(`p-${id}`),
    command: launcher(`launch-${id}`),
    ...over,
  };
}

const noExec: ExecFn = () => Promise.reject(new Error('exec must not run'));

function deps(exec: ExecFn = noExec, env: NodeJS.ProcessEnv = {}): DoctorDeps {
  return {
    env: {
      WINGMAN_HOME: home,
      CLAUDE_DEFAULT_DIR: defaultDir,
      CLAUDE_CONFIG_DIR: defaultDir,
      PATH: root,
      ...env,
    },
    homeDir: root,
    exec,
  };
}

async function doctor(
  args: string[] = [],
  d: DoctorDeps = deps(),
): Promise<{ code: number | undefined; results: CheckResult[] }> {
  const code = await maybeRunCli(['node', 'index.js', 'doctor', '--json', ...args], d);
  const text = out.join('');
  return { code, results: text ? (JSON.parse(text) as CheckResult[]) : [] };
}

const find = (results: CheckResult[], id: string): CheckResult | undefined =>
  results.find((r) => r.id === id);

describe('doctor state and registry', () => {
  it('is all ok for a healthy setup and exits 0', async () => {
    writeRegistry([acct('b')]);
    const { code, results } = await doctor();
    expect(code).toBe(0);
    expect(results.every((r) => r.level === 'ok')).toBe(true);
    expect(find(results, 'state.dir')?.level).toBe('ok');
    expect(find(results, 'registry.parse')?.message).toContain('1 account');
  });

  it('warns when the state directory is missing', async () => {
    const { code, results } = await doctor();
    expect(code).toBe(0);
    expect(find(results, 'state.dir')?.level).toBe('warn');
    expect(find(results, 'registry.accounts')?.level).toBe('warn');
  });

  it('warns about loose directory and file modes', async () => {
    writeRegistry([acct('b')], 0o755, 0o644);
    const { code, results } = await doctor();
    expect(code).toBe(0);
    expect(find(results, 'state.dir')?.level).toBe('warn');
    expect(find(results, 'registry.mode')?.level).toBe('warn');
  });

  it('warns when the registry is missing but the directory exists', async () => {
    mkdirSync(home, { mode: 0o700 });
    const { results } = await doctor();
    expect(find(results, 'registry.file')?.level).toBe('warn');
  });

  it('fails on invalid JSON, a missing accounts array and a bad entry', async () => {
    mkdirSync(home, { mode: 0o700 });
    const file = join(home, 'accounts.json');
    for (const body of ['{nope', '{"accounts":1}', '{"accounts":[{"id":"x"}]}', 'null']) {
      writeFileSync(file, body, { mode: 0o600 });
      out = [];
      const { code, results } = await doctor();
      expect(code).toBe(1);
      expect(find(results, 'registry.parse')?.level).toBe('fail');
    }
  });

  it('fails on duplicate ids', async () => {
    writeRegistry([acct('b'), acct('b')]);
    const { code, results } = await doctor();
    expect(code).toBe(1);
    expect(find(results, 'registry.parse')?.message).toContain('duplicate');
  });

  it('warns when only the caller own profile is registered', async () => {
    writeRegistry([acct('me', { config_dir: defaultDir })]);
    const { code, results } = await doctor();
    expect(code).toBe(0);
    expect(find(results, 'registry.accounts')?.level).toBe('warn');
    expect(find(results, 'account.me.self')?.level).toBe('warn');
  });

  it('defaults the home to ~/.wingman and the default profile to ~/.claude', async () => {
    const d = deps(noExec, { WINGMAN_HOME: '', CLAUDE_DEFAULT_DIR: '', CLAUDE_CONFIG_DIR: '' });
    const { results } = await doctor([], d);
    expect(find(results, 'state.dir')?.message).toContain(join(root, '.wingman'));
  });

  it('text output has one line per result and a summary', async () => {
    writeRegistry([acct('b', { config_dir: join(root, 'gone') })]);
    const code = await maybeRunCli(['node', 'index.js', 'doctor'], deps());
    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toMatch(/^\[ok\] /m);
    expect(text).toMatch(/^\[fail\] b: config_dir/m);
    expect(text).toMatch(/wingman doctor: \d+ ok, \d+ warn, 1 fail\n$/);
  });
});

describe('doctor accounts', () => {
  it('fails on a missing config_dir', async () => {
    writeRegistry([acct('b', { config_dir: join(root, 'gone') })]);
    const { code, results } = await doctor();
    expect(code).toBe(1);
    expect(find(results, 'account.b.config_dir')?.level).toBe('fail');
  });

  it('fails when the command is not executable or not found', async () => {
    writeRegistry([
      acct('b', { command: launcher('plain', false) }),
      acct('c', { command: 'no-such-launcher' }),
    ]);
    const { code, results } = await doctor();
    expect(code).toBe(1);
    expect(find(results, 'account.b.command')?.message).toContain('not executable');
    expect(find(results, 'account.c.command')?.message).toContain('not found');
  });

  it('resolves a bare command name on PATH', async () => {
    launcher('on-path');
    writeRegistry([acct('b', { command: 'on-path' })]);
    const { results } = await doctor();
    expect(find(results, 'account.b.command')?.level).toBe('ok');
  });

  it('reports status without judging it', async () => {
    writeRegistry([acct('b', { status: 'disabled' }), acct('c', { status: 'weird' })]);
    const { code, results } = await doctor();
    expect(code).toBe(0);
    expect(find(results, 'account.b.status')?.level).toBe('ok');
    expect(find(results, 'account.c.status')?.message).toContain('unknown value');
  });
});

describe('doctor shared items', () => {
  it('checks linked, broken, forked, other-target and absent items', async () => {
    for (const item of ['CLAUDE.md', 'settings.json', 'rules']) {
      writeFileSync(join(defaultDir, item), 'x');
    }
    mkdirSync(join(defaultDir, 'skills'));
    mkdirSync(join(defaultDir, 'agents'));
    const a = acct('b');
    const dir = a.config_dir as string;
    symlinkSync(join(defaultDir, 'CLAUDE.md'), join(dir, 'CLAUDE.md'));
    symlinkSync(join(root, 'missing-target'), join(dir, 'settings.json'));
    writeFileSync(join(dir, 'rules'), 'forked');
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(root, 'elsewhere'), 'x');
    symlinkSync(join(root, 'elsewhere'), join(dir, 'agents'));
    writeRegistry([a]);

    const { code, results } = await doctor();
    expect(code).toBe(1);
    expect(find(results, 'account.b.shared.CLAUDE.md')?.level).toBe('ok');
    expect(find(results, 'account.b.shared.settings.json')).toMatchObject({
      level: 'fail',
      message: expect.stringContaining('broken link'),
    });
    expect(find(results, 'account.b.shared.rules')).toMatchObject({
      level: 'warn',
      message: expect.stringContaining('forked, no longer shared'),
    });
    expect(find(results, 'account.b.shared.skills')?.level).toBe('warn');
    expect(find(results, 'account.b.shared.agents')?.message).toContain('somewhere other');
    expect(find(results, 'account.b.shared.commands')).toBeUndefined();
  });

  it('an absent item is ok and info only', async () => {
    writeFileSync(join(defaultDir, 'CLAUDE.md'), 'x');
    writeRegistry([acct('b')]);
    const { code, results } = await doctor();
    expect(code).toBe(0);
    expect(find(results, 'account.b.shared.CLAUDE.md')).toMatchObject({
      level: 'ok',
      message: expect.stringContaining('absent'),
    });
  });
});

describe('doctor plugin version', () => {
  function installed(dir: string, body: unknown): void {
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(
      join(dir, 'plugins', 'installed_plugins.json'),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }
  const entry = (version: string): unknown => ({
    version: 2,
    plugins: { 'wingman@wingman-marketplace': [{ scope: 'user', version, installPath: '/x' }] },
  });

  it('ok when equal, warn when different, ok when absent', async () => {
    const same = acct('same');
    const diff = acct('diff');
    const none = acct('none');
    const nofile = acct('nofile');
    const bad = acct('bad');
    installed(same.config_dir as string, entry(pkg.version));
    installed(diff.config_dir as string, entry('0.0.1'));
    installed(none.config_dir as string, { version: 2, plugins: {} });
    installed(bad.config_dir as string, '{nope');
    writeRegistry([same, diff, none, nofile, bad]);
    const { code, results } = await doctor();
    expect(code).toBe(0);
    expect(find(results, 'account.same.plugin')?.level).toBe('ok');
    expect(find(results, 'account.diff.plugin')?.level).toBe('warn');
    expect(find(results, 'account.none.plugin')?.message).toContain('not installed');
    expect(find(results, 'account.nofile.plugin')?.level).toBe('ok');
    expect(find(results, 'account.bad.plugin')?.level).toBe('warn');
  });
});

describe('doctor --online', () => {
  const status = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: EMAIL,
      orgId: ORG,
      accessToken: TOKEN,
      ...over,
    });

  /** The caller runs `claude`; accounts run their own launcher, told apart by path. */
  function execFor(byCommand: Record<string, string | Error>): ExecFn {
    return (file, args) => {
      expect(args).toEqual(['auth', 'status', '--json']);
      const r = byCommand[file];
      if (r === undefined) return Promise.reject(new Error('unexpected command'));
      return r instanceof Error ? Promise.reject(r) : Promise.resolve({ stdout: r });
    };
  }

  const noSecrets = (): void => {
    const all = [...out, ...err].join('');
    for (const secret of [EMAIL, ORG, TOKEN, 'accessToken']) expect(all).not.toContain(secret);
  };

  it('reports a different, signed-in account without printing identity', async () => {
    const b = acct('b');
    writeRegistry([b]);
    const exec = execFor({
      claude: status(),
      [b.command as string]: status({ email: `x${EMAIL}`, authMethod: 'console' }),
    });
    const { code, results } = await doctor(['--online'], deps(exec));
    expect(code).toBe(0);
    expect(find(results, 'online.caller')?.message).toBe(
      'caller: signed in yes, authMethod claude.ai',
    );
    expect(find(results, 'online.b')).toMatchObject({
      level: 'ok',
      message: 'b: signed in yes, authMethod console, different account from the caller: yes',
    });
    noSecrets();
  });

  it('warns when the profile reports the caller account', async () => {
    const b = acct('b');
    writeRegistry([b]);
    const exec = execFor({ claude: status(), [b.command as string]: status() });
    const { results } = await doctor(['--online'], deps(exec));
    expect(find(results, 'online.b')?.level).toBe('warn');
    expect(find(results, 'online.b')?.message).toContain('different account from the caller: no');
    noSecrets();
  });

  it('warns when not signed in, with an unknown comparison', async () => {
    const b = acct('b');
    writeRegistry([b]);
    const exec = execFor({
      claude: status(),
      [b.command as string]: JSON.stringify({ loggedIn: false }),
    });
    const { code, results } = await doctor(['--online'], deps(exec));
    expect(code).toBe(0);
    expect(find(results, 'online.b')).toMatchObject({
      level: 'warn',
      message: 'b: signed in no, authMethod unknown, different account from the caller: unknown',
    });
  });

  it('warns on timeout, non-zero exit and garbage output', async () => {
    const b = acct('b');
    const c = acct('c');
    const d = acct('d');
    const e = acct('e');
    writeRegistry([b, c, d, e]);
    const exec = execFor({
      claude: new Error('boom'),
      [b.command as string]: Object.assign(new Error('t'), { killed: true }),
      [c.command as string]: Object.assign(new Error('x'), { code: 3 }),
      [d.command as string]: `not json ${EMAIL} ${TOKEN}`,
      [e.command as string]: '[1]',
    });
    const { code, results } = await doctor(['--online'], deps(exec));
    expect(code).toBe(0);
    expect(find(results, 'online.caller')?.level).toBe('warn');
    expect(find(results, 'online.b')?.message).toContain('timed out');
    expect(find(results, 'online.c')?.message).toContain('code 3');
    expect(find(results, 'online.d')?.message).toContain('not JSON');
    expect(find(results, 'online.e')?.message).toContain('not a JSON object');
    noSecrets();
  });

  it('prints only a plain authMethod string', async () => {
    const b = acct('b');
    writeRegistry([b]);
    const exec = execFor({
      claude: status(),
      [b.command as string]: status({ authMethod: `${TOKEN} with spaces` }),
    });
    await doctor(['--online'], deps(exec));
    noSecrets();
  });

  it('runs a fake launcher through the real exec and never offline', async () => {
    const b = acct('b');
    const path = b.command as string;
    writeFileSync(
      path,
      `#!/bin/sh\necho '{"loggedIn":true,"authMethod":"api_key","email":"${EMAIL}","orgId":"${ORG}"}'\n`,
    );
    writeRegistry([b]);
    const base = defaultDeps();
    const bin = join(root, 'claude');
    writeFileSync(bin, '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claudeai"}\'\n');
    chmodSync(bin, 0o755);
    const d: DoctorDeps = {
      ...deps(base.exec),
      env: { ...deps().env, PATH: `${root}:/usr/bin:/bin` },
    };
    const { results } = await doctor(['--online'], d);
    expect(find(results, 'online.b')?.message).toContain('authMethod api_key');
    expect(find(results, 'online.b')?.message).toContain('unknown');
    noSecrets();
  });

  it('does not call exec without --online', async () => {
    writeRegistry([acct('b')]);
    const exec = vi.fn(noExec);
    await doctor([], deps(exec));
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('doctor usage', () => {
  it('exits 2 on an unknown argument', async () => {
    const code = await maybeRunCli(['node', 'index.js', 'doctor', '--bogus'], deps());
    expect(code).toBe(2);
    expect(err.join('')).toContain('usage: wingman doctor [--online] [--json]');
    expect(out).toEqual([]);
  });
});
