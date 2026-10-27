import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveAccounts } from '../src/registry.js';
import { readMeta } from '../src/runs.js';
import { buildServer, createHandlers } from '../src/tools.js';
import { waitForRun } from '../src/runner.js';
import { bundleSupervisor, git, makeLauncher, makeRepo, readLog, tmp } from './helpers.js';

const DIST = join(import.meta.dirname, '..', 'dist', 'index.js');
const TOOLS = [
  'wingman_cancel',
  'wingman_cleanup',
  'wingman_list',
  'wingman_result',
  'wingman_start',
  'wingman_status',
];

let work: string;
let entry: string;
let home: string;
let callerDir: string;
let savedHome: string | undefined;
const clients: Client[] = [];

beforeAll(async () => {
  work = tmp('srv');
  entry = await bundleSupervisor(work);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

beforeEach(() => {
  savedHome = process.env.WINGMAN_HOME;
  home = tmp('home');
  process.env.WINGMAN_HOME = home;
  callerDir = join(home, 'cfg-caller');
  mkdirSync(callerDir);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  if (savedHome === undefined) delete process.env.WINGMAN_HOME;
  else process.env.WINGMAN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const callerEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: callerDir,
});

async function register(command: string): Promise<void> {
  const account = (id: string, dir: string) => ({
    id,
    label: id,
    config_dir: dir,
    provider: 'claude',
    command,
  });
  await saveAccounts({
    accounts: [account('target', join(home, 'cfg-target')), account('self', callerDir)],
  });
}

async function connect(): Promise<Client> {
  const server = buildServer({ env: callerEnv(), supervisorEntry: entry });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

interface Reply {
  isError: boolean;
  text: string;
  data: Record<string, unknown> & { runs?: Record<string, unknown>[] };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = res.content.map((c) => c.text).join('\n');
  let data: Reply['data'] = {};
  if (!res.isError) data = JSON.parse(text) as Reply['data'];
  return { isError: res.isError === true, text, data };
}

function launcher(mode: string): { command: string; log: string } {
  const log = join(work, `log-${Math.random().toString(16).slice(2)}.jsonl`);
  return { command: makeLauncher(work, mode, log), log };
}

const settle = async (id: string) => waitForRun(id, { timeoutMs: 20000, pollMs: 50 });

function leakyLauncher(secret: string): string {
  const script = join(work, `leaky-${Math.random().toString(16).slice(2)}.mjs`);
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's' },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: `EVENTS-ONLY-MARKER ${secret}` }] },
    },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `Authorization: Bearer ${secret}\n${'y'.repeat(6000)}\nWINGMAN_STATUS: done`,
      permission_denials: [],
    },
  ];
  writeFileSync(
    script,
    `${lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join('\n')}\n`,
  );
  const path = join(work, `leaky-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('tools end to end', () => {
  it('start, status, result and list in a plain directory', async () => {
    const { command } = launcher('ok');
    await register(command);
    const client = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS);

    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'do it',
      cwd: tmp('cwd'),
      preset: 'edit',
    });
    expect(started.isError).toBe(false);
    expect(Object.keys(started.data).sort()).toEqual(['account', 'run_id', 'status']);
    const id = started.data.run_id as string;
    expect(started.data.status).toBe('running');

    await settle(id);
    const status = await call(client, 'wingman_status', { run_id: id });
    expect(status.data).toMatchObject({ id, account: 'target', status: 'done', has_result: true });
    expect(status.data).not.toHaveProperty('result');

    const result = await call(client, 'wingman_result', { run_id: id });
    expect(result.data.status).toBe('done');
    expect(result.data.result).toMatch(/Implemented the change/);

    const list = await call(client, 'wingman_list', { limit: 5 });
    expect(list.data.runs).toHaveLength(1);
    expect(Object.keys(list.data.runs![0]!).sort()).toEqual([
      'account',
      'created_at',
      'id',
      'status',
    ]);
  });

  it('start in a repo makes a run branch, cleanup removes the worktree but keeps the branch', async () => {
    const { command } = launcher('ok');
    await register(command);
    const client = await connect();
    const repo = makeRepo('feat/x');
    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'do it',
      cwd: repo,
      preset: 'edit',
    });
    expect(started.isError).toBe(false);
    const branch = started.data.run_branch as string;
    expect(branch).toBeTruthy();
    const id = started.data.run_id as string;
    await settle(id);
    const worktree = readMeta(id).worktree as string;
    expect(existsSync(worktree)).toBe(true);

    const status = await call(client, 'wingman_status', { run_id: id });
    expect(status.data.branch).toBe('feat/x');
    expect(status.data.run_branch).toBe(branch);

    const cleaned = await call(client, 'wingman_cleanup', { run_id: id, action: 'discard' });
    expect(cleaned.data).toMatchObject({ worktree_removed: true, kept_branch: branch });
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', branch)).toContain(branch);
  });

  it('worktree true outside a repo is refused', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    const res = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'x',
      cwd: tmp('cwd'),
      worktree: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/git repository/);
  });
});

describe('refusals and errors', () => {
  it('refuses the caller own profile and unknown accounts', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    const base = { prompt: 'x', cwd: tmp('cwd') };
    const own = await call(client, 'wingman_start', { ...base, account: 'self' });
    expect(own.isError).toBe(true);
    expect(own.text).toMatch(/own profile/);
    const unknown = await call(client, 'wingman_start', { ...base, account: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Unknown account "nope"/);
  });

  it('refuses an explicitly named inactive account', async () => {
    const command = launcher('ok').command;
    await saveAccounts({
      accounts: [
        {
          id: 'target',
          label: 'target',
          config_dir: join(home, 'cfg-target'),
          provider: 'claude',
          command,
          status: 'disabled',
        },
      ],
    });
    const client = await connect();
    const res = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'x',
      cwd: tmp('cwd'),
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/"target" is disabled, not active/);
  });

  it('refuses a relative or missing cwd', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    for (const cwd of ['relative/dir', join(home, 'missing')]) {
      const res = await call(client, 'wingman_start', { account: 'target', prompt: 'x', cwd });
      expect(res.isError).toBe(true);
    }
  });

  it('unknown run ids give a short error for every run tool', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    const calls: [string, Record<string, unknown>][] = [
      ['wingman_status', {}],
      ['wingman_result', {}],
      ['wingman_cancel', {}],
      ['wingman_cleanup', { action: 'accept' }],
    ];
    for (const [name, extra] of calls) {
      const res = await call(client, name, { run_id: 'deadbeef', ...extra });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Unknown run id/);
      expect(res.text).not.toContain(home);
    }
  });

  it('invalid input is an error, not a crash', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    const outcome = await call(client, 'wingman_start', { account: 'target' }).then(
      (r) => r.isError,
      () => true,
    );
    expect(outcome).toBe(true);
    const bad = await call(client, 'wingman_status', { run_id: '../etc' });
    expect(bad.isError).toBe(true);
  });
});

describe('output safety', () => {
  it('never returns events.jsonl content; result is masked and capped', async () => {
    const secret = ['sk', 'ant', 'oat01', 'AAAABBBBCCCCDDDD1234'].join('-');
    await register(leakyLauncher(secret));
    const client = await connect();
    const outputs: string[] = [];
    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'x',
      cwd: tmp('cwd'),
      preset: 'edit',
    });
    outputs.push(started.text);
    const id = started.data.run_id as string;
    await settle(id);
    for (const name of ['wingman_status', 'wingman_result']) {
      outputs.push((await call(client, name, { run_id: id })).text);
    }
    outputs.push((await call(client, 'wingman_list', {})).text);
    const result = await call(client, 'wingman_result', { run_id: id });
    expect(result.data.status).toBe('done');
    expect(result.data.result as string).toMatch(/truncated/);
    expect((result.data.result as string).length).toBeLessThan(4200);
    for (const out of outputs) {
      expect(out).not.toContain(secret);
      expect(out).not.toContain('EVENTS-ONLY-MARKER');
    }
  });
});

describe('send, cancel, cleanup', () => {
  it('result says still running, cleanup is refused, cancel works', async () => {
    await register(launcher('hang').command);
    const client = await connect();
    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'x',
      cwd: tmp('cwd'),
    });
    const id = started.data.run_id as string;
    const result = await call(client, 'wingman_result', { run_id: id });
    expect(result.data).toMatchObject({ status: 'running', message: 'still running' });
    expect(result.data).not.toHaveProperty('result');

    const cleanup = await call(client, 'wingman_cleanup', { run_id: id, action: 'discard' });
    expect(cleanup.isError).toBe(true);
    expect(cleanup.text).toMatch(/still running/);

    await new Promise((r) => setTimeout(r, 400));
    const cancelled = await call(client, 'wingman_cancel', { run_id: id });
    expect(cancelled.data).toMatchObject({ run_id: id, cancelled: true });
    await settle(id);
    expect((await call(client, 'wingman_status', { run_id: id })).data.status).toBe('cancelled');
    const again = await call(client, 'wingman_cancel', { run_id: id });
    expect(again.data.cancelled).toBe(false);
  });

  it('start returns the chosen account and defaults to the readonly preset', async () => {
    const ok = launcher('ok');
    await register(ok.command);
    const client = await connect();
    const started = await call(client, 'wingman_start', { prompt: 'x', cwd: tmp('cwd') });
    expect(started.isError).toBe(false);
    expect(started.data.account).toBe('target');
    await settle(started.data.run_id as string);
    const argv = readLog(ok.log)[0]!.argv;
    const allowed = argv.slice(argv.indexOf('--allowedTools') + 1);
    expect(allowed).toContain('Grep');
    expect(allowed).not.toContain('Edit');
  });

  it('wingman_send is not a tool', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('wingman_send');
    expect(names).toHaveLength(6);
  });
});

describe('account selection', () => {
  const acct = (id: string, dir: string, status?: string) => ({
    id,
    label: id,
    config_dir: dir,
    provider: 'claude',
    command: 'x',
    ...(status !== undefined ? { status } : {}),
  });
  const pick = async (random: () => number): Promise<string> => {
    const h = createHandlers({ env: callerEnv(), supervisorEntry: entry, random });
    const res = await h.start({ prompt: 'x', cwd: tmp('cwd') });
    await settle(res.run_id as string);
    return res.account as string;
  };

  it('picks with the injected RNG among the other active accounts', async () => {
    const ok = launcher('ok');
    const a = (id: string, dir: string, status?: string) => ({
      ...acct(id, dir, status),
      command: ok.command,
    });
    await saveAccounts({
      accounts: [
        a('own', callerDir),
        a('one', join(home, 'c1')),
        a('off', join(home, 'c2'), 'disabled'),
        a('two', join(home, 'c3'), 'active'),
      ],
    });
    expect(await pick(() => 0)).toBe('one');
    expect(await pick(() => 0.99)).toBe('two');
    for (let i = 0; i < 6; i++) {
      expect(['one', 'two']).toContain(await pick(Math.random));
    }
  });

  it('errors when nobody else is available', async () => {
    const h = createHandlers({ env: callerEnv(), supervisorEntry: entry, random: () => 0 });
    await saveAccounts({ accounts: [] });
    await expect(h.start({ prompt: 'x', cwd: tmp('cwd') })).rejects.toThrow(/No other active/);
    await saveAccounts({
      accounts: [acct('own', callerDir), acct('off', join(home, 'c2'), 'disabled')],
    });
    await expect(h.start({ prompt: 'x', cwd: tmp('cwd') })).rejects.toThrow(/No other active/);
  });

  it('an explicit account still works and the own profile is refused', async () => {
    const ok = launcher('ok');
    await saveAccounts({
      accounts: [
        { ...acct('own', callerDir), command: ok.command },
        { ...acct('named', join(home, 'c1')), command: ok.command },
      ],
    });
    const h = createHandlers({ env: callerEnv(), supervisorEntry: entry, random: () => 0 });
    const res = await h.start({ account: 'named', prompt: 'x', cwd: tmp('cwd') });
    expect(res.account).toBe('named');
    await settle(res.run_id as string);
    await expect(h.start({ account: 'own', prompt: 'x', cwd: tmp('cwd') })).rejects.toThrow(
      /own profile/,
    );
  });
});

describe.skipIf(!existsSync(DIST))('bundled entry', () => {
  it('stdio: initialize, tools/list and a run whose supervisor is the same bundle', async () => {
    const { command } = launcher('ok');
    await register(command);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST],
      env: { PATH: process.env.PATH ?? '', WINGMAN_HOME: home, CLAUDE_CONFIG_DIR: callerDir },
    });
    const client = new Client({ name: 't', version: '0' });
    clients.push(client);
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS);

    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'x',
      cwd: tmp('cwd'),
    });
    expect(started.isError).toBe(false);
    const meta = await settle(started.data.run_id as string);
    expect(meta.status).toBe('done');
  });

  it('supervisor mode does not start the MCP server and keeps stdout clean', async () => {
    const child = spawn(process.execPath, [DIST, '--supervise', 'abc123'], {
      env: { PATH: process.env.PATH ?? '', WINGMAN_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    );
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(1);
    expect(out).toBe('');
  });
});
