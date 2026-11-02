import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../src/adapters/index.js';
import { opencodeAdapter, permissionFor } from '../src/adapters/opencode.js';
import { guardPrompt } from '../src/guard.js';
import { startRun, waitForRun, type StartRunOptions } from '../src/runner.js';
import { readMeta, runSummary } from '../src/runs.js';
import type { Account, StartSpec } from '../src/types.js';
import { bundleSupervisor, git, makeRepo, tmp } from './helpers.js';

const FAKE = resolve(__dirname, 'fixtures/fake-opencode.mjs');
const account: Account = {
  id: 'oc',
  label: 'oc',
  config_dir: '/cfg/oc',
  provider: 'opencode',
  command: 'opencode',
};
const spec: StartSpec = {
  prompt: 'do it',
  cwd: '/work',
  allowed_tools: [],
  disallowed_tools: [],
  session_id: 'sid',
  append_system_prompt: guardPrompt('opencode'),
  preset: 'readonly',
  model: 'prov/model-1',
};

describe('opencode permissions', () => {
  const bash = (preset: string) => permissionFor(preset).bash as Record<string, string>;
  const keys = (b: Record<string, string>) => Object.keys(b);

  it('always denies web, nested agents and paths outside the worktree', () => {
    for (const preset of ['readonly', 'edit-files', 'edit']) {
      expect(permissionFor(preset)).toMatchObject({
        webfetch: 'deny',
        task: 'deny',
        external_directory: 'deny',
      });
    }
  });

  it('readonly cannot edit and only reads with git; deny rules come last so they win', () => {
    const p = permissionFor('readonly');
    expect(p.edit).toBe('deny');
    const b = bash('readonly');
    expect(keys(b)[0]).toBe('*');
    expect(b['*']).toBe('deny');
    expect(b['git status']).toBe('allow');
    expect(b['git status *']).toBe('allow');
    expect(b['git commit *']).toBeUndefined();
    expect(b['node *']).toBeUndefined();
    expect(b['date']).toBe('allow');
    expect(b['date +*']).toBe('allow');
    expect(keys(b).indexOf('*--output*')).toBeGreaterThan(keys(b).indexOf('git diff *'));
    expect(b['*--output*']).toBe('deny');
  });

  it('edit-files adds editing and git commits; edit adds node and npm but never publish', () => {
    expect(permissionFor('edit-files').edit).toBe('allow');
    expect(bash('edit-files')['git commit *']).toBe('allow');
    expect(bash('edit-files')['npm run *']).toBeUndefined();
    expect(bash('edit')['npm run *']).toBe('allow');
    expect(bash('edit')['npm install *']).toBe('allow');
    expect(bash('edit')['git push *']).toBeUndefined();
  });

  it('allows commands by name only: no unanchored prefix, no publish, config or exec', () => {
    for (const preset of ['readonly', 'edit-files', 'edit']) {
      const allowed = Object.entries(bash(preset))
        .filter(([, v]) => v === 'allow')
        .map(([k]) => k);
      expect(allowed.filter((k) => /[a-z]\*$/.test(k))).toEqual([]);
      expect(
        allowed.some((k) => /difftool|publish|config|exec|commit-tree|show-branch/.test(k)),
      ).toBe(false);
    }
    const never = bash('edit');
    for (const p of ['*--output*', '*--no-index*', '*--ext-diff*', '*--global*', '* -g *']) {
      expect(never[p]).toBe('deny');
    }
    expect(Object.keys(never).slice(-8)).toContain('*--global*');
  });
});

describe('opencode adapter command and env', () => {
  it('builds the run command with --standalone and the prompt on stdin', () => {
    const { command, args } = opencodeAdapter.buildCommand(account, spec);
    expect(command).toBe('opencode');
    expect(args).toEqual(['run', '--format', 'json', '--standalone', '-m', 'prov/model-1']);
    expect(args).not.toContain('--auto');
    expect(args.join(' ')).not.toContain('do it');
    const { model: _ignored, ...rest } = spec;
    void _ignored;
    expect(opencodeAdapter.buildCommand(account, rest as StartSpec).args).not.toContain('-m');
  });

  it('prepends the guardrail to the prompt', () => {
    const text = opencodeAdapter.buildPrompt!(spec);
    expect(text.startsWith(guardPrompt('opencode'))).toBe(true);
    expect(text.endsWith('do it')).toBe(true);
  });

  it('isolates XDG dirs, injects the permission config and drops other env', () => {
    const env = opencodeAdapter.buildEnv(
      { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'x', XDG_DATA_HOME: '/leak' },
      account,
      1,
      spec,
    );
    expect(env.XDG_DATA_HOME).toBe('/cfg/oc/data');
    expect(env.npm_config_userconfig).toBe('/cfg/oc/npmrc');
    expect(env.XDG_CONFIG_HOME).toBe('/cfg/oc/config');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).permission.edit).toBe('deny');
    expect(opencodeAdapter.buildEnv({}, account, 1).OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it('is registered and declares what it cannot do', () => {
    expect(getAdapter('opencode')).toBe(opencodeAdapter);
    expect(opencodeAdapter.capabilities).toEqual({
      allowedTools: false,
      maxTurns: false,
      agentCommits: true,
    });
  });
});

describe('opencode event parsing', () => {
  const parse = (lines: unknown[]) => {
    const p = opencodeAdapter.createLineParser!();
    return lines.flatMap((l) => p(typeof l === 'string' ? l : JSON.stringify(l)));
  };
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    sessionID: 's1',
    ...extra,
  });

  it('reports the session once and finishes on the stop step with the last text', () => {
    const events = parse([
      ev('step_start', { part: { type: 'step-start' } }),
      'stray text',
      ev('text', { part: { type: 'text', text: 'first' } }),
      ev('step_finish', { part: { type: 'step-finish', reason: 'tool-calls' } }),
      ev('step_start', { part: { type: 'step-start' } }),
      ev('text', { part: { type: 'text', text: 'final\nWINGMAN_STATUS: done' } }),
      ev('step_finish', { part: { type: 'step-finish', reason: 'stop' } }),
    ]);
    expect(events.filter((e) => e.kind === 'started')).toEqual([
      { kind: 'started', session_id: 's1' },
    ]);
    expect(events.filter((e) => e.kind === 'finished')).toEqual([
      {
        kind: 'finished',
        result: 'final\nWINGMAN_STATUS: done',
        is_error: false,
        permission_denials: [],
      },
    ]);
  });

  it('records permission denials from tools and counts tools', () => {
    const events = parse([
      ev('tool_use', {
        part: {
          type: 'tool',
          tool: 'shell',
          state: { status: 'error', error: 'Permission denied: shell' },
        },
      }),
      ev('tool_use', { part: { type: 'tool', tool: 'read', state: { status: 'completed' } } }),
      ev('step_finish', { part: { reason: 'stop' } }),
    ]);
    expect(events.filter((e) => e.kind === 'tool')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ kind: 'finished', permission_denials: ['shell'] });
  });

  it('error events end the run as an error; 429 or a limit message rejects the account', () => {
    const plain = parse([ev('error', { error: { message: 'boom', status: 400 } })]);
    expect(plain).toEqual([
      expect.objectContaining({ kind: 'started' }),
      { kind: 'finished', result: 'boom', is_error: true, permission_denials: [] },
    ]);
    const limited = parse([ev('error', { error: { message: 'x', status: 429 } })]);
    expect(limited.some((e) => e.kind === 'rate_limited')).toBe(true);
    const byText = parse([ev('error', { error: { message: 'You hit the rate limit' } })]);
    expect(byText.some((e) => e.kind === 'rate_limited')).toBe(true);
    const disk = parse([ev('error', { error: { message: 'disk quota exceeded' } })]);
    expect(disk.some((e) => e.kind === 'rate_limited')).toBe(false);
    expect(parse([ev('error')]).at(-1)).toMatchObject({ is_error: true });
    expect(opencodeAdapter.isRateLimitRejected({ status: 'rejected' })).toBe(true);
  });

  it('reads nested error text and emits only one finished', () => {
    const nested = parse([ev('error', { error: { data: { message: 'usage limit reached' } } })]);
    expect(nested.some((e) => e.kind === 'rate_limited')).toBe(true);
    expect(nested.at(-1)).toMatchObject({ result: 'usage limit reached' });
    const named = parse([ev('error', { error: { name: 'APIError' } })]);
    expect(named.at(-1)).toMatchObject({ result: 'APIError' });
    const twice = parse([
      ev('error', { error: { message: 'boom' } }),
      ev('step_finish', { part: { reason: 'stop' } }),
      ev('error', { error: { message: 'again' } }),
    ]);
    expect(twice.filter((e) => e.kind === 'finished')).toHaveLength(1);
  });

  it('ignores garbage, non-final steps and unknown events', () => {
    expect(
      parse(['[1]', '{"type":"x"}', ev('step_finish', { part: { reason: 'tool-calls' } })]),
    ).toEqual([expect.objectContaining({ kind: 'started' })]);
    expect(opencodeAdapter.parseLine('{"type":"text","part":{"text":"hi"}}')).toEqual([
      { kind: 'message', text: 'hi' },
    ]);
  });
});

let work: string;
let entry: string;
let home: string;
let saved: string | undefined;
beforeAll(async () => {
  work = tmp('oc');
  entry = await bundleSupervisor(work);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeEach(() => {
  saved = process.env.WINGMAN_HOME;
  home = tmp('oc-home');
  process.env.WINGMAN_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.WINGMAN_HOME;
  else process.env.WINGMAN_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

function runOpts(mode: string, extra: Partial<StartRunOptions> = {}) {
  const log = join(work, `log-${Math.random().toString(16).slice(2)}.jsonl`);
  const launcher = join(work, `oc-${mode}.sh`);
  writeFileSync(
    launcher,
    `#!/bin/sh\nexport FAKE_OC_MODE=${mode} FAKE_OC_LOG=${log}\nexec "${process.execPath}" "${FAKE}" "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  const opts: StartRunOptions = {
    account: { ...account, command: launcher, config_dir: join(home, 'cfg-oc') },
    prompt: 'do it',
    cwd: tmp('cwd'),
    parentEnv: { PATH: process.env.PATH ?? '', HOME: home, WINGMAN_HOME: home },
    supervisorEntry: entry,
    preset: 'readonly',
    ...extra,
  };
  return { opts, log };
}

const settle = (id: string) => waitForRun(id, { timeoutMs: 20000, pollMs: 50 });
const record = (log: string) =>
  JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]!) as {
    argv: string[];
    prompt: string;
    env_names: string[];
    xdg_data: string;
    permission: { edit: string };
    cwd: string;
  };

describe('opencode run through the supervisor', () => {
  it('runs readonly: prompt on stdin, XDG isolated, permissions injected, report done', async () => {
    const { opts, log } = runOpts('ok');
    const meta = await settle((await startRun(opts)).id);
    expect(meta.status).toBe('done');
    expect(runSummary(meta.id).result).toContain('Done the work.');
    const rec = record(log);
    expect(rec.prompt).toContain('delegated wingman run');
    expect(rec.argv.join(' ')).not.toContain('delegated wingman run');
    expect(rec.xdg_data).toBe(join(opts.account.config_dir, 'data'));
    expect(rec.permission.edit).toBe('deny');
    expect(rec.cwd).toBe(opts.cwd);
  });

  it('maps errors, rate limits, missing finish and denials', async () => {
    expect((await settle((await startRun(runOpts('fail').opts)).id)).status).toBe('failed');
    expect((await settle((await startRun(runOpts('ratelimit').opts)).id)).status).toBe(
      'rate_limited',
    );
    expect((await settle((await startRun(runOpts('nofinish').opts)).id)).status).toBe(
      'failed_no_report',
    );
    const denied = await settle((await startRun(runOpts('denied').opts)).id);
    expect(denied.permission_denials).toEqual(['shell']);
  });

  it('refuses max_turns and allowed_tools before starting', async () => {
    await expect(startRun({ ...runOpts('ok').opts, max_turns: 5 })).rejects.toThrow('max_turns');
    await expect(startRun({ ...runOpts('ok').opts, allowed_tools: ['Read'] })).rejects.toThrow(
      'allowed_tools',
    );
  });

  it('lets the agent commit itself: no wingman commit on top', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/o');
    const { opts, log } = runOpts('edit', { cwd: repo, worktree: true, preset: 'edit-files' });
    const meta = await settle((await startRun(opts)).id);
    expect(meta.status).toBe('done');
    expect(runSummary(meta.id).result).not.toContain('wingman committed');
    expect(record(log).permission.edit).toBe('allow');
    const branch = readMeta(meta.id).run_branch!;
    expect(git(repo, 'log', '--format=%an', `feat/o..${branch}`).trim()).toBe('oc');
  });
});
