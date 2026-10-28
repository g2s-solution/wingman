import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeRunCli } from '../src/cli.js';
import { buildServer } from '../src/tools.js';
import { tmp } from './helpers.js';

let home: string;
let callerDir: string;
let saved: Record<string, string | undefined>;
let out: string[];
let err: string[];

beforeEach(() => {
  home = tmp('accounts');
  callerDir = join(home, 'caller-profile');
  mkdirSync(callerDir);
  saved = {
    WINGMAN_HOME: process.env.WINGMAN_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.WINGMAN_HOME = join(home, 'state');
  process.env.CLAUDE_CONFIG_DIR = callerDir;
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
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const cli = (...args: string[]) => maybeRunCli(['node', 'index.js', 'accounts', ...args]);
const registryFile = () => join(home, 'state', 'accounts.json');
const registry = () =>
  JSON.parse(readFileSync(registryFile(), 'utf8')) as { accounts: Record<string, unknown>[] };
const stdout = () => out.join('');
const stderr = () => err.join('');

async function addAccount(id: string, dir = join(home, `profile-${id}`), ...more: string[]) {
  expect(await cli('add', '--id', id, '--config-dir', dir, ...more)).toBe(0);
}

describe('wingman accounts add', () => {
  it('registers a new account with defaults and private modes', async () => {
    const dir = join(home, 'p1');
    await addAccount('one', dir, '--label', 'claude-one', '--command', '/bin/launch');
    expect(stdout()).toBe('registered one\n');
    expect(registry().accounts).toEqual([
      {
        id: 'one',
        label: 'claude-one',
        config_dir: dir,
        provider: 'claude',
        command: '/bin/launch',
      },
    ]);
    expect(statSync(registryFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'state')).mode & 0o777).toBe(0o700);
  });

  it('defaults label to the id and command to claude', async () => {
    await addAccount('two');
    expect(registry().accounts[0]).toMatchObject({ label: 'two', command: 'claude' });
  });

  it('refuses a duplicate id without --upsert', async () => {
    await addAccount('one');
    expect(await cli('add', '--id', 'one', '--config-dir', join(home, 'other'))).toBe(2);
    expect(stderr()).toMatch(/already exists/);
    expect(registry().accounts).toHaveLength(1);
  });

  it('--upsert updates the given fields and keeps hand-set ones such as status', async () => {
    await addAccount('one', join(home, 'a'), '--label', 'first');
    expect(await cli('disable', 'one')).toBe(0);
    out.length = 0;
    await addAccount('one', join(home, 'b'), '--upsert', '--command', '/bin/x');
    expect(stdout()).toBe('updated one\n');
    expect(registry().accounts[0]).toMatchObject({
      label: 'first',
      status: 'disabled',
      config_dir: join(home, 'b'),
      command: '/bin/x',
    });
  });

  it('registers the caller profile with a note, also through a different spelling', async () => {
    expect(await cli('add', '--id', 'me', '--config-dir', callerDir)).toBe(0);
    expect(stdout()).toMatch(
      /registered me\nnote: me is the profile you are running in; it is skipped/,
    );
    out.length = 0;
    expect(await cli('add', '--id', 'me2', '--config-dir', `${callerDir}/sub/..`)).toBe(0);
    expect(stdout()).toMatch(/^note: me2 is the profile you are running in/m);
    expect(registry().accounts.map((a) => a.id)).toEqual(['me', 'me2']);
  });

  it('prints no note for another profile', async () => {
    await addAccount('other', join(home, 'o'));
    expect(stdout()).not.toMatch(/note:/);
  });

  it.each([
    ['relative', 'rel/dir'],
    ['bare name', 'claude-second'],
    ['empty', ''],
  ])('refuses a %s config-dir', async (_n, dir) => {
    expect(await cli('add', '--id', 'x', '--config-dir', dir)).toBe(2);
    expect(stderr()).toMatch(/config-dir/);
  });

  it.each(['', 'a b', 'a/b', 'x'.repeat(65), 'é'])('refuses the id %j', async (id) => {
    expect(await cli('add', '--id', id, '--config-dir', join(home, 'p'))).toBe(2);
  });

  it('refuses an empty command or label', async () => {
    expect(await cli('add', '--id', 'x', '--config-dir', join(home, 'p'), '--command', ' ')).toBe(
      2,
    );
    expect(await cli('add', '--id', 'x', '--config-dir', join(home, 'p'), '--label', '')).toBe(2);
  });

  it('expands ~ and normalizes the path', async () => {
    await addAccount('tilde', '~/wm-test-profile/../wm-other');
    expect(registry().accounts[0]!.config_dir).toBe(join(homedir(), 'wm-other'));
  });

  it('needs --id and --config-dir, and a value for each flag', async () => {
    expect(await cli('add', '--id', 'x')).toBe(2);
    expect(await cli('add', '--config-dir', join(home, 'p'))).toBe(2);
    expect(await cli('add', '--id')).toBe(2);
    expect(await cli('add', '--id', 'x', '--bogus')).toBe(2);
    expect(await cli('add', 'stray')).toBe(2);
  });
});

describe('wingman accounts list', () => {
  it('says so when the registry is empty', async () => {
    expect(await cli('list')).toBe(0);
    expect(stdout()).toBe('no accounts registered\n');
  });

  it('prints a table and marks the caller profile', async () => {
    await addAccount('other', join(home, 'o'), '--label', 'claude-other', '--command', '/bin/o');
    // an entry pointing at the caller profile, as an older registry may have
    const reg = registry();
    reg.accounts.push({
      id: 'me',
      label: 'me',
      config_dir: callerDir,
      provider: 'claude',
      command: 'claude',
      status: 'disabled',
    });
    writeFileSync(registryFile(), JSON.stringify(reg));
    out.length = 0;
    expect(await cli('list')).toBe(0);
    const lines = stdout().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ID\s+LABEL\s+STATUS\s+LIMITED_UNTIL\s+RUNS\s+CONFIG_DIR\s+COMMAND/);
    expect(lines[1]).toMatch(/^other\s+claude-other\s+active\s+-\s+-\s+\S+\s+\/bin\/o$/);
    expect(lines[2]).toMatch(/^me\s+me\s+disabled\s+-\s+-\s+\S+\s+claude\s+this profile$/);
  });

  it('--json prints the same fields plus is_caller', async () => {
    await addAccount('other', join(home, 'o'));
    out.length = 0;
    expect(await cli('list', '--json')).toBe(0);
    expect(JSON.parse(stdout())).toEqual([
      {
        id: 'other',
        label: 'other',
        status: 'active',
        provider: 'claude',
        config_dir: join(home, 'o'),
        command: 'claude',
        is_caller: false,
        runs: { total: 0, by_status: {} },
      },
    ]);
  });

  it('rejects stray arguments', async () => {
    expect(await cli('list', 'x')).toBe(2);
    expect(await cli('list', '--nope')).toBe(2);
  });
});

describe('wingman accounts disable, enable and remove', () => {
  it('disable and enable round trip, removing the status field', async () => {
    await addAccount('one');
    expect(await cli('disable', 'one')).toBe(0);
    expect(registry().accounts[0]!.status).toBe('disabled');
    expect(stdout()).toMatch(/disabled one/);
    expect(await cli('enable', 'one')).toBe(0);
    expect(registry().accounts[0]).not.toHaveProperty('status');
    expect(stdout()).toMatch(/enabled one/);
  });

  it('remove without --yes only says what it would do and exits 2', async () => {
    await addAccount('one');
    out.length = 0;
    expect(await cli('remove', 'one')).toBe(2);
    expect(stdout()).toMatch(/would remove one/);
    expect(registry().accounts).toHaveLength(1);
  });

  it('remove --yes deletes the entry and leaves the profile directory alone', async () => {
    const dir = join(home, 'profile-keep');
    mkdirSync(dir);
    writeFileSync(join(dir, 'marker'), 'x');
    await addAccount('one', dir);
    await addAccount('two');
    expect(await cli('remove', 'one', '--yes')).toBe(0);
    expect(registry().accounts.map((a) => a.id)).toEqual(['two']);
    expect(readFileSync(join(dir, 'marker'), 'utf8')).toBe('x');
  });

  it.each(['disable', 'enable', 'remove'])(
    '%s on an unknown id exits 2 and lists the ids',
    async (verb) => {
      await addAccount('one');
      await addAccount('two');
      expect(await cli(verb, 'nope', ...(verb === 'remove' ? ['--yes'] : []))).toBe(2);
      expect(stderr()).toMatch(/unknown account "nope"\. Registered accounts: one, two/);
    },
  );

  it('says none when the registry is empty', async () => {
    expect(await cli('disable', 'x')).toBe(2);
    expect(stderr()).toMatch(/Registered accounts: none/);
  });

  it('needs exactly one id and refuses --yes outside remove', async () => {
    expect(await cli('disable')).toBe(2);
    expect(await cli('disable', 'a', 'b')).toBe(2);
    await addAccount('one');
    expect(await cli('disable', 'one', '--yes')).toBe(2);
  });
});

describe('exit codes', () => {
  it('a missing or unknown subcommand is a usage error', async () => {
    expect(await cli()).toBe(2);
    expect(await cli('frobnicate')).toBe(2);
    expect(stderr()).toMatch(/usage: wingman accounts list/);
  });

  it('an unreadable registry is an unexpected error, exit 1', async () => {
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(registryFile(), '{not json');
    expect(await cli('list')).toBe(1);
    expect(stderr()).toMatch(/not valid JSON/);
  });
});

describe('wingman_accounts tool', () => {
  it('lists id, label, status, is_caller and provider only, and has no mutating siblings', async () => {
    await addAccount('other', join(home, 'o'), '--command', '/secret/launcher');
    await cli('disable', 'other');
    const server = buildServer({ env: { CLAUDE_CONFIG_DIR: callerDir } });
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'wingman_accounts',
      'wingman_cancel',
      'wingman_cleanup',
      'wingman_list',
      'wingman_result',
      'wingman_start',
      'wingman_status',
    ]);

    const res = await client.callTool({ name: 'wingman_accounts', arguments: {} });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual({
      accounts: [
        {
          id: 'other',
          label: 'other',
          status: 'disabled',
          is_caller: false,
          provider: 'claude',
          runs: { total: 0, by_status: {} },
        },
      ],
    });
    expect(text).not.toMatch(/launcher|command|config_dir|\/o"/);
    await client.close();
    await server.close();
  });
});
