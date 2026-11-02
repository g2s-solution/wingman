import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import { getAdapter } from '../src/adapters/index.js';
import { guardPrompt } from '../src/guard.js';
import { startRun, waitForRun, type StartRunOptions } from '../src/runner.js';
import { readMeta, runSummary } from '../src/runs.js';
import type { Account, StartSpec } from '../src/types.js';
import { bundleSupervisor, git, makeRepo, tmp } from './helpers.js';

const FAKE_CODEX = resolve(__dirname, 'fixtures/fake-codex.mjs');
const account: Account = {
  id: 'cx',
  label: 'cx',
  config_dir: '/cfg/codex',
  provider: 'codex',
  command: 'codex',
};
const spec: StartSpec = {
  prompt: 'do it',
  cwd: '/work',
  allowed_tools: [],
  disallowed_tools: [],
  session_id: 'sid',
  append_system_prompt: guardPrompt('codex'),
  preset: 'readonly',
  model: 'gpt-x',
};

describe('codex adapter command and env', () => {
  it('builds the exec command with isolation flags and the prompt on stdin', () => {
    const { command, args } = codexAdapter.buildCommand(account, spec);
    expect(command).toBe('codex');
    expect(args).toEqual([
      'exec',
      '--json',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/work',
      '-s',
      'read-only',
      '-m',
      'gpt-x',
      '-',
    ]);
    expect(args.join(' ')).not.toContain('do it');
    expect(args.some((a) => a.startsWith('--dangerously'))).toBe(false);
  });

  it('maps presets to sandboxes and omits -m without a model', () => {
    const { model: _model, ...noModel } = spec;
    for (const preset of ['edit-files', 'edit']) {
      const { args } = codexAdapter.buildCommand(account, { ...noModel, preset });
      expect(args[args.indexOf('-s') + 1]).toBe('workspace-write');
      expect(args).not.toContain('-m');
    }
  });

  it('prepends the guardrail to the prompt', () => {
    const text = codexAdapter.buildPrompt!(spec);
    expect(text.startsWith(guardPrompt('codex'))).toBe(true);
    expect(text.endsWith('do it')).toBe(true);
  });

  it('keeps only allowlisted env names and sets CODEX_HOME and depth', () => {
    const env = codexAdapter.buildEnv(
      { PATH: '/bin', HOME: '/h', LC_ALL: 'C', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' },
      account,
      2,
    );
    expect(Object.keys(env).sort()).toEqual([
      'CODEX_HOME',
      'HOME',
      'LC_ALL',
      'PATH',
      'WINGMAN_DEPTH',
    ]);
    expect(env.CODEX_HOME).toBe('/cfg/codex');
    expect(env.WINGMAN_DEPTH).toBe('2');
  });

  it('is registered and declares what it cannot do', () => {
    expect(getAdapter('codex')).toBe(codexAdapter);
    expect(codexAdapter.capabilities).toEqual({
      allowedTools: false,
      maxTurns: false,
      agentCommits: false,
    });
  });
});

describe('codex event parsing', () => {
  const parse = (lines: unknown[]) => {
    const p = codexAdapter.createLineParser!();
    return lines.flatMap((l) => p(typeof l === 'string' ? l : JSON.stringify(l)));
  };

  it('finishes with the last agent message and ignores transient errors', () => {
    const events = parse([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      { type: 'error', message: 'Reconnecting... 2/5' },
      'stray text',
      { type: 'item.completed', item: { type: 'error', message: 'fallback' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'final\nWINGMAN_STATUS: done' },
      },
      { type: 'turn.completed', usage: {} },
    ]);
    expect(events[0]).toEqual({ kind: 'started', session_id: 't1' });
    expect(events.at(-1)).toEqual({
      kind: 'finished',
      result: 'final\nWINGMAN_STATUS: done',
      is_error: false,
      permission_denials: [],
    });
    expect(events.some((e) => e.kind === 'rate_limited')).toBe(false);
  });

  it('turn.failed is an error, and a limit message also rejects the account', () => {
    const failed = parse([{ type: 'turn.failed', error: { message: 'model exploded' } }]);
    expect(failed).toEqual([
      { kind: 'finished', result: 'model exploded', is_error: true, permission_denials: [] },
    ]);
    const limited = parse([
      { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } },
    ]);
    const info = limited.find((e) => e.kind === 'rate_limited');
    expect(info).toMatchObject({ kind: 'rate_limited', info: { status: 'rejected' } });
    expect(codexAdapter.isRateLimitRejected({ status: 'rejected' })).toBe(true);
    expect(codexAdapter.isRateLimitRejected({})).toBe(false);
    expect(parse([{ type: 'turn.failed' }])[0]).toMatchObject({ is_error: true });
  });

  it('turn.completed without a message gives a null result; command items count as tools', () => {
    expect(parse([{ type: 'turn.completed' }])).toEqual([
      { kind: 'finished', result: null, is_error: false, permission_denials: [] },
    ]);
    expect(
      parse([{ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }]),
    ).toEqual([{ kind: 'tool', name: 'command' }]);
    expect(codexAdapter.parseLine('{"type":"thread.started","thread_id":"z"}')).toHaveLength(1);
    expect(parse(['[1]', '{"type":"item.completed","item":5}', '{"type":"x"}'])).toEqual([]);
  });
});

let work: string;
let entry: string;
let home: string;
let saved: string | undefined;
beforeAll(async () => {
  work = tmp('codex');
  entry = await bundleSupervisor(work);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeEach(() => {
  saved = process.env.WINGMAN_HOME;
  home = tmp('codex-home');
  process.env.WINGMAN_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.WINGMAN_HOME;
  else process.env.WINGMAN_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

function runOpts(mode: string, extra: Partial<StartRunOptions> = {}) {
  const log = join(work, `log-${Math.random().toString(16).slice(2)}.jsonl`);
  const launcher = join(work, `codex-${mode}.sh`);
  writeFileSync(
    launcher,
    `#!/bin/sh\nexport FAKE_CODEX_MODE=${mode} FAKE_CODEX_LOG=${log}\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  const parentEnv = { PATH: process.env.PATH ?? '', HOME: home, WINGMAN_HOME: home };
  const opts: StartRunOptions = {
    account: { ...account, command: launcher, config_dir: join(home, 'cfg-codex') },
    prompt: 'do it',
    cwd: tmp('cwd'),
    parentEnv,
    supervisorEntry: entry,
    preset: 'readonly',
    ...extra,
  };
  return { opts, log };
}

const settle = (id: string) => waitForRun(id, { timeoutMs: 20000, pollMs: 50 });
const records = (log: string) =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(
      (l) =>
        JSON.parse(l) as {
          argv: string[];
          prompt: string;
          env_names: string[];
          codex_home: string;
        },
    );

describe('codex run through the supervisor', () => {
  it('runs readonly: guardrail on stdin only, CODEX_HOME set, report done', async () => {
    const { opts, log } = runOpts('ok');
    const meta = await settle((await startRun(opts)).id);
    expect(meta.status).toBe('done');
    expect(runSummary(meta.id).result).toContain('Done the work.');
    const rec = records(log)[0]!;
    expect(rec.prompt).toContain('delegated wingman run');
    expect(rec.prompt.endsWith('do it')).toBe(true);
    expect(rec.argv.join(' ')).not.toContain('delegated wingman run');
    expect(rec.codex_home).toBe(opts.account.config_dir);
    expect(rec.env_names).not.toContain('ANTHROPIC_API_KEY');
  });

  it('maps a failed turn to failed and a limit to rate_limited', async () => {
    expect((await settle((await startRun(runOpts('fail').opts)).id)).status).toBe('failed');
    expect((await settle((await startRun(runOpts('ratelimit').opts)).id)).status).toBe(
      'rate_limited',
    );
    expect((await settle((await startRun(runOpts('nomessage').opts)).id)).status).toBe(
      'needs_input',
    );
  });

  it('refuses max_turns and allowed_tools for codex before starting', async () => {
    await expect(startRun({ ...runOpts('ok').opts, max_turns: 5 })).rejects.toThrow('max_turns');
    await expect(startRun({ ...runOpts('ok').opts, allowed_tools: ['Read'] })).rejects.toThrow(
      'allowed_tools',
    );
  });

  it('commits the changes of an edit run on the run branch', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/c');
    const { opts } = runOpts('edit', { cwd: repo, worktree: true, preset: 'edit-files' });
    const meta = await settle((await startRun(opts)).id);
    expect(meta.status).toBe('done');
    expect(runSummary(meta.id).result).toContain('wingman committed its changes');
    const branch = readMeta(meta.id).run_branch!;
    expect(git(repo, 'show', '--stat', '--format=%an %s', branch)).toMatch(
      /wingman wingman run .*edited\.txt/s,
    );
    expect(existsSync(join(repo, 'edited.txt'))).toBe(false);
  });
});
