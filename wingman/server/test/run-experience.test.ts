import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { DEFAULT_MAX_TURNS, defaultMaxTurns, guardPrompt } from '../src/guard.js';
import { saveAccounts } from '../src/registry.js';
import { createRun, readMeta, updateStatus, writeResult } from '../src/runs.js';
import { waitForRun } from '../src/runner.js';
import { closestKey, unknownParameterMessage } from '../src/strict.js';
import { buildServer } from '../src/tools.js';
import {
  bundleSupervisor,
  git,
  makeLauncher,
  makeRepo,
  readLog,
  tmp,
  waitUntil,
} from './helpers.js';

const p = (data: unknown) => claudeAdapter.parseLine(JSON.stringify(data));
const denials = (list: unknown[]): string[] => {
  const [event] = p({ type: 'result', subtype: 'success', result: 'x', permission_denials: list });
  return event?.kind === 'finished' ? event.permission_denials : [];
};

describe('denied commands in the adapter', () => {
  it('keeps the tool name, plus two masked words for Bash', () => {
    expect(
      denials([
        { tool_name: 'Bash', tool_input: { command: 'cd /work/tree && npm test --flag value' } },
        { tool_name: 'Bash', tool_input: { command: 'npx   vitest run' } },
        { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/x' } },
        { tool_name: 'Bash' },
        { tool_name: 'Bash', tool_input: { command: '   ' } },
        { tool_name: 'Bash', tool_input: 'not an object' },
      ]),
    ).toEqual(['Bash(cd /work/tree)', 'Bash(npx vitest)', 'WebFetch', 'Bash', 'Bash', 'Bash']);
  });

  it('masks and truncates the head, never reports later words', () => {
    const [masked, long, later] = denials([
      { tool_name: 'Bash', tool_input: { command: 'curl Bearer abcdefghijklmnop12345 --data x' } },
      { tool_name: 'Bash', tool_input: { command: `${'a'.repeat(100)} b` } },
      { tool_name: 'Bash', tool_input: { command: 'echo hi SECRETWORD-in-third' } },
    ]);
    expect(masked).not.toContain('abcdefghijklmnop12345');
    expect(masked).not.toContain('--data');
    expect(long!.length).toBeLessThan(100);
    expect(long).toContain('truncated');
    expect(later).toBe('Bash(echo hi)');
  });

  it('masks a credential that is one of the first two words', () => {
    const [out] = denials([
      { tool_name: 'Bash', tool_input: { command: 'export token=abc123secretvalue' } },
    ]);
    expect(out).not.toContain('abc123secretvalue');
  });
});

describe('guard prompt and default max_turns', () => {
  it('carries the worktree-root rule and keeps the status rule last', () => {
    const lines = guardPrompt().split('\n');
    const rule = lines.find((l) => l.startsWith('5. '));
    expect(rule).toMatch(/already in the worktree root/);
    expect(rule).toMatch(/never cd and never use git -C/);
    expect(rule).toMatch(/npm run <script>, not npx/);
    expect(lines.at(-1)).toMatch(/^6\. Always end with a final report/);
  });

  it('has a default per preset and none for an unknown one', () => {
    expect(DEFAULT_MAX_TURNS).toEqual({ readonly: 40, 'edit-files': 100, edit: 200 });
    expect(defaultMaxTurns(undefined)).toBe(40);
    expect(defaultMaxTurns('readonly')).toBe(40);
    expect(defaultMaxTurns('edit-files')).toBe(100);
    expect(defaultMaxTurns('edit')).toBe(200);
    expect(defaultMaxTurns('toString')).toBeUndefined();
  });
});

describe('unknown parameter messages', () => {
  const known = ['run_id', 'offset', 'limit'];

  it('suggests a contained or near key and nothing for an unrelated one', () => {
    expect(closestKey('result_offset', known)).toBe('offset');
    expect(closestKey('limt', known)).toBe('limit');
    expect(closestKey('runid', known)).toBe('run_id');
    expect(closestKey('zzzzzzzz', known)).toBeUndefined();
    expect(closestKey('x', [])).toBeUndefined();
  });

  it('names every unknown key', () => {
    expect(unknownParameterMessage('wingman_result', ['result_offset', 'zzzzzzzz'], known)).toBe(
      'unknown parameter "result_offset" for wingman_result (did you mean "offset"?); unknown parameter "zzzzzzzz" for wingman_result',
    );
  });
});

let work: string;
let entry: string;
let home: string;
let callerDir: string;
let savedHome: string | undefined;
const clients: Client[] = [];

beforeAll(async () => {
  work = tmp('rx');
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
  const server = buildServer({
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: callerDir },
    supervisorEntry: entry,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

interface Reply {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const res = (await client.callTool({ name, arguments: args }).catch((err: Error) => ({
    isError: true,
    content: [{ type: 'text', text: err.message }],
  }))) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = res.content.map((c) => c.text).join('\n');
  return { isError: res.isError === true, text, data: res.isError ? {} : JSON.parse(text) };
}

function launcher(mode: string): { command: string; log: string } {
  const log = join(work, `log-${Math.random().toString(16).slice(2)}.jsonl`);
  return { command: makeLauncher(work, mode, log), log };
}

const settle = async (id: string) => waitForRun(id, { timeoutMs: 20000, pollMs: 50 });

const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  wingman_start: { prompt: 'x', cwd: '/tmp' },
  wingman_status: { run_id: 'abc' },
  wingman_result: { run_id: 'abc' },
  wingman_cancel: { run_id: 'abc' },
  wingman_list: {},
  wingman_accounts: {},
  wingman_cleanup: { run_id: 'abc', action: 'accept' },
};

describe('strict tool schemas', () => {
  it('every tool rejects an unknown parameter naming the key', async () => {
    const client = await connect();
    for (const [name, args] of Object.entries(TOOL_ARGS)) {
      const res = await call(client, name, { ...args, bogus_param: 1 });
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toContain(`unknown parameter "bogus_param" for ${name}`);
    }
  });

  it('suggests the closest known key', async () => {
    const client = await connect();
    const res = await call(client, 'wingman_result', { run_id: 'abc', result_offset: 4000 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(
      'unknown parameter "result_offset" for wingman_result (did you mean "offset"?)',
    );
    const typo = await call(client, 'wingman_start', { prompt: 'x', cwd: '/tmp', max_turn: 5 });
    expect(typo.text).toContain('(did you mean "max_turns"?)');
  });

  it('still advertises a valid object schema that lists the known keys', async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
    const result = tools.find((t) => t.name === 'wingman_result')!;
    expect(Object.keys(result.inputSchema.properties ?? {}).sort()).toEqual([
      'limit',
      'offset',
      'run_id',
    ]);
    expect(result.inputSchema.additionalProperties).toBe(false);
    const start = tools.find((t) => t.name === 'wingman_start')!;
    expect(start.description).toBeTruthy();
    const turns = (start.inputSchema.properties as Record<string, { description?: string }>)
      .max_turns!;
    expect(turns.description).toMatch(/readonly 40, edit-files 100, edit 200/);
  });

  it('valid calls still work', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    expect((await call(client, 'wingman_accounts', {})).isError).toBe(false);
    expect((await call(client, 'wingman_list', { limit: 3 })).isError).toBe(false);
  });
});

describe('result hints and paging', () => {
  it('a running run gets a wingman-wait hint and keeps the still running message', async () => {
    const hang = launcher('hang');
    await register(hang.command);
    const client = await connect();
    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'x',
      cwd: tmp('cwd'),
    });
    const id = started.data.run_id as string;
    const res = await call(client, 'wingman_result', { run_id: id });
    expect(res.data).toMatchObject({ status: 'running', message: 'still running' });
    expect(res.data.hint).toContain(`bin/wingman-wait ${id}`);
    await waitUntil(() => existsSync(hang.log), { what: 'the agent to start' });
    await call(client, 'wingman_cancel', { run_id: id });
    await settle(id);
  });

  it('pages_left and next accompany result_next_offset and vanish on the last page', async () => {
    const client = await connect();
    const meta = createRun({
      account: 'target',
      cwd: '/x',
      session_id: 's',
      depth: 1,
      prompt_chars: 1,
    });
    writeResult(meta.id, 'a'.repeat(9500));
    updateStatus(meta.id, 'done');

    const first = await call(client, 'wingman_result', { run_id: meta.id, limit: 4000 });
    expect(first.data).toMatchObject({
      result_next_offset: 4000,
      pages_left: 2,
      next: 'call again with offset=4000',
    });
    const second = await call(client, 'wingman_result', {
      run_id: meta.id,
      limit: 4000,
      offset: 4000,
    });
    expect(second.data).toMatchObject({
      result_next_offset: 8000,
      pages_left: 1,
      next: 'call again with offset=8000',
    });
    const last = await call(client, 'wingman_result', {
      run_id: meta.id,
      limit: 4000,
      offset: 8000,
    });
    expect(last.data).not.toHaveProperty('result_next_offset');
    expect(last.data).not.toHaveProperty('pages_left');
    expect(last.data).not.toHaveProperty('next');
  });

  it('a partial run with denials gets a de-duplicated, capped hint of heads only', async () => {
    const client = await connect();
    const denied = [
      'Bash(cd /w)',
      'Bash(cd /w)',
      'Bash(npx vitest)',
      'WebFetch',
      'Bash(git -C)',
      'Bash(ls -la)',
      'Bash(rm -rf)',
    ];
    const meta = createRun({
      account: 'target',
      cwd: '/x',
      session_id: 's',
      depth: 1,
      prompt_chars: 1,
    });
    writeResult(meta.id, 'half done');
    updateStatus(meta.id, 'partial', { permission_denials: denied });

    for (const name of ['wingman_status', 'wingman_result']) {
      const res = await call(client, name, { run_id: meta.id });
      const hint = res.data.hint as string;
      expect(hint, name).toContain(
        'Bash(cd /w), Bash(npx vitest), WebFetch, Bash(git -C), Bash(ls -la)',
      );
      expect(hint, name).not.toContain('Bash(rm -rf)');
      expect(hint.match(/Bash\(cd \/w\)/g), name).toHaveLength(1);
      expect(hint, name).toMatch(/no cd, no git -C, npm run <script> not npx/);
      expect(hint, name).toMatch(/another preset/);
    }
  });

  it('a no_status run with denials gets the same denied-commands hint', async () => {
    const client = await connect();
    const meta = createRun({
      account: 'target',
      cwd: '/x',
      session_id: 's',
      depth: 1,
      prompt_chars: 1,
    });
    writeResult(meta.id, 'report without a status line');
    updateStatus(meta.id, 'no_status', { permission_denials: ['Bash(find /)'] });
    const res = await call(client, 'wingman_result', { run_id: meta.id });
    expect(res.data.status).toBe('no_status');
    expect(res.data.hint as string).toContain('Bash(find /)');
  });

  it('adds no denial hint when partial has none or the run is done', async () => {
    const client = await connect();
    const mk = (status: 'partial' | 'done', permission_denials: string[]) => {
      const meta = createRun({
        account: 'target',
        cwd: '/x',
        session_id: 's',
        depth: 1,
        prompt_chars: 1,
      });
      updateStatus(meta.id, status, { permission_denials });
      return meta.id;
    };
    for (const id of [mk('partial', []), mk('done', ['Bash(cd /w)'])]) {
      expect((await call(client, 'wingman_result', { run_id: id })).data).not.toHaveProperty(
        'hint',
      );
    }
  });
});

describe('cleanup accept', () => {
  it('returns run_branch, a capped diff_stat and a review note for a run with a branch', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    const repo = makeRepo('feat/x');
    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'do it',
      cwd: repo,
      preset: 'edit',
    });
    const id = started.data.run_id as string;
    const branch = started.data.run_branch as string;
    await settle(id);
    const worktree = readMeta(id).worktree as string;
    writeFileSync(join(worktree, 'new-file.txt'), 'hello\n');
    git(worktree, 'add', 'new-file.txt');
    git(
      worktree,
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '-m',
      'add',
    );

    const res = await call(client, 'wingman_cleanup', { run_id: id, action: 'accept' });
    expect(res.data).toMatchObject({ action: 'accept', kept_branch: branch, run_branch: branch });
    const stat = res.data.diff_stat as string;
    expect(stat).toContain('new-file.txt');
    expect(stat).toMatch(/1 file changed/);
    expect(stat).not.toContain('hello');
    expect(stat.length).toBeLessThanOrEqual(2100);
    expect(res.data.note).toMatch(/Review the diff before merging/);
    expect(res.data.note).toContain(branch);
  });

  it('discard is unchanged: no diff_stat, no note', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    const repo = makeRepo('feat/y');
    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'do it',
      cwd: repo,
      preset: 'edit',
    });
    const id = started.data.run_id as string;
    await settle(id);
    const res = await call(client, 'wingman_cleanup', { run_id: id, action: 'discard' });
    expect(Object.keys(res.data).sort()).toEqual([
      'action',
      'kept_branch',
      'run_id',
      'worktree_removed',
    ]);
  });

  it('accept on a readonly run says it is equivalent to discard, without an error', async () => {
    await register(launcher('ok').command);
    const client = await connect();
    const repo = makeRepo('feat/z');
    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'look',
      cwd: repo,
    });
    const id = started.data.run_id as string;
    await settle(id);
    const res = await call(client, 'wingman_cleanup', { run_id: id, action: 'accept' });
    expect(res.isError).toBe(false);
    expect(res.data.note).toMatch(/accept and discard are equivalent/);
    expect(res.data).not.toHaveProperty('diff_stat');
    expect(res.data).not.toHaveProperty('run_branch');
  });
});

describe('default max_turns by preset', () => {
  const turnsOf = (log: string): string | undefined => {
    const argv = readLog(log).at(-1)!.argv;
    const at = argv.indexOf('--max-turns');
    return at === -1 ? undefined : argv[at + 1];
  };

  async function run(args: Record<string, unknown>): Promise<string | undefined> {
    const l = launcher('ok');
    await register(l.command);
    const client = await connect();
    const started = await call(client, 'wingman_start', {
      account: 'target',
      prompt: 'x',
      cwd: tmp('cwd'),
      ...args,
    });
    expect(started.isError, started.text).toBe(false);
    await settle(started.data.run_id as string);
    return turnsOf(l.log);
  }

  it.each([
    [undefined, '40'],
    ['readonly', '40'],
    ['edit-files', '100'],
    ['edit', '200'],
  ])('preset %s defaults to %s', async (preset, turns) => {
    expect(await run(preset === undefined ? {} : { preset })).toBe(turns);
  });

  it('an explicit value wins, also above the default', async () => {
    expect(await run({ preset: 'edit', max_turns: 7 })).toBe('7');
    expect(await run({ preset: 'readonly', max_turns: 900 })).toBe('900');
  });
});
