import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDir, wingmanHome, worktreesDir } from '../src/paths.js';
import { startRun, waitForRun, type StartRunOptions } from '../src/runner.js';
import { createHandlers } from '../src/tools.js';
import { DEFAULT_NO_PID_GRACE_MS } from '../src/reconcile.js';
import { updateStatus } from '../src/runs.js';
import {
  START_BUDGET_MS,
  defaultExec,
  pruneOrphans,
  runSetup,
  type ExecFn,
} from '../src/worktree.js';
import type { RunMeta } from '../src/types.js';
import {
  bundleSupervisor,
  git,
  makeAccount,
  makeLauncher,
  makeRepo,
  readLog,
  tmp,
} from './helpers.js';

let work: string;
let entry: string;
let home: string;
let saved: string | undefined;
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME });
const noSleep = (): Promise<void> => Promise.resolve();

beforeAll(async () => {
  work = tmp('bundle');
  entry = await bundleSupervisor(work);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeEach(() => {
  saved = process.env.WINGMAN_HOME;
  home = tmp('home');
  process.env.WINGMAN_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.WINGMAN_HOME;
  else process.env.WINGMAN_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

function launcher(mode: string): { command: string; log: string } {
  const log = join(work, `log-${Math.random().toString(16).slice(2)}.jsonl`);
  return { command: makeLauncher(work, mode, log), log };
}

function startOpts(command: string, extra: Partial<StartRunOptions>): StartRunOptions {
  return {
    account: makeAccount(command, join(home, 'cfg-target')),
    prompt: 'do it',
    cwd: tmp('cwd'),
    parentEnv: env(),
    supervisorEntry: entry,
    preset: 'edit',
    sleep: noSleep,
    ...extra,
  };
}

const settle = (m: RunMeta): Promise<RunMeta> => waitForRun(m.id, { timeoutMs: 20000, pollMs: 50 });

function lockFiles(): { run_id: string; pid: number }[] {
  const dir = join(wingmanHome(), 'locks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

async function finishedWorktreeRun(lockKey = 'chg'): Promise<{ repo: string; first: RunMeta }> {
  const repo = makeRepo('main');
  git(repo, 'switch', '-q', '-c', 'feat/c');
  const first = await settle(
    await startRun(
      startOpts(launcher('ok').command, { cwd: repo, worktree: true, lock_key: lockKey }),
    ),
  );
  expect(first.status).toBe('done');
  return { repo, first };
}

describe('run_cwd (M3)', () => {
  it('stores the effective cwd through a symlinked subdirectory', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/s');
    const link = join(tmp('link'), 'via');
    symlinkSync(join(repo, 'sub'), link);
    const { command, log } = launcher('ok');
    const first = await settle(await startRun(startOpts(command, { cwd: link, worktree: true })));
    expect(first.run_cwd).toBe(join(first.worktree as string, 'sub'));
    expect(readLog(log)[0]!.cwd).toBe(join(first.worktree as string, 'sub'));
  });

  it('rejects a cwd that resolves outside the repository toplevel', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/o');
    const other = makeRepo('main');
    git(other, 'switch', '-q', '-c', 'feat/x');
    const exec: ExecFn = async (file, args, opts) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { code: 0, stdout: `${other}\n`, stderr: '' };
      }
      return defaultExec(file, args, opts);
    };
    await expect(
      startRun(startOpts(launcher('ok').command, { cwd: repo, worktree: true, exec })),
    ).rejects.toThrow(/outside/);
    expect(existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')) : []).toEqual([]);
  });
});

describe('timeouts and clean failed starts (M6, L3)', () => {
  it('defaultExec kills the whole process group on timeout and reports code 124', async () => {
    const started = Date.now();
    const res = await defaultExec('sh', ['-c', 'sleep 30 & sleep 30'], {
      cwd: tmp('x'),
      env: env(),
      timeoutMs: 300,
    });
    expect(res.code).toBe(124);
    expect(res.stderr).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('runSetup times out', async () => {
    const res = await runSetup(tmp('x'), 'sleep 30', env(), 300);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/timed out/);
  });

  it('a setup timeout removes the run dir, worktree and lock', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/t');
    await expect(
      startRun(
        startOpts(launcher('ok').command, {
          cwd: repo,
          worktree: true,
          lock_key: 'c',
          setup: 'sleep 30',
          setup_timeout_ms: 300,
        }),
      ),
    ).rejects.toThrow(/setup command failed/);
    expect(readdirSync(join(home, 'runs'))).toEqual([]);
    expect(existsSync(worktreesDir()) ? readdirSync(worktreesDir()) : []).toEqual([]);
    expect(lockFiles()).toEqual([]);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('a hung git worktree add is cut by its timeout and leaves nothing behind', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/h');
    const exec: ExecFn = async (file, args, opts) =>
      args[0] === 'worktree' && args[1] === 'add'
        ? defaultExec('sh', ['-c', 'sleep 30'], opts)
        : defaultExec(file, args, opts);
    await expect(
      startRun(
        startOpts(launcher('ok').command, {
          cwd: repo,
          worktree: true,
          lock_key: 'c',
          exec,
          worktree_timeout_ms: 300,
        }),
      ),
    ).rejects.toThrow(/worktree add failed/);
    expect(readdirSync(join(home, 'runs'))).toEqual([]);
    expect(lockFiles()).toEqual([]);
  });

  it('a failed spawn in startRun releases the worktree and lock', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/f');
    await expect(
      startRun(
        startOpts(launcher('ok').command, {
          cwd: repo,
          worktree: true,
          lock_key: 'c',
          supervisorEntry: '',
        }),
      ),
    ).rejects.toThrow(/supervisor/i);
    expect(lockFiles()).toEqual([]);
    expect(existsSync(worktreesDir()) ? readdirSync(worktreesDir()) : []).toEqual([]);
  });
});

describe('uncommitted changes (L4)', () => {
  it('cleanup refuses accept on a dirty worktree, allows discard; prune skips it', async () => {
    const { first } = await finishedWorktreeRun();
    writeFileSync(join(first.worktree as string, 'wip.txt'), 'x');
    expect(await pruneOrphans()).toEqual([]);
    expect(existsSync(first.worktree as string)).toBe(true);
    const h = createHandlers({ env: env() });
    await expect(h.cleanup({ run_id: first.id, action: 'accept' })).rejects.toThrow(
      /uncommitted changes/,
    );
    expect(existsSync(first.worktree as string)).toBe(true);
    await h.cleanup({ run_id: first.id, action: 'discard' });
    expect(existsSync(first.worktree as string)).toBe(false);
    expect(existsSync(runDir(first.id))).toBe(true);
  });

  it('accept and prune remove a clean worktree', async () => {
    const { first } = await finishedWorktreeRun();
    const h = createHandlers({ env: env() });
    await h.cleanup({ run_id: first.id, action: 'accept' });
    expect(existsSync(first.worktree as string)).toBe(false);
  });
});

describe('start budget and terminal runs', () => {
  it('the start budget is below the no-pid grace', () => {
    expect(START_BUDGET_MS).toBeLessThan(DEFAULT_NO_PID_GRACE_MS);
  });

  it('git steps and setup are cut to the remaining start budget', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/b');
    const seen: Record<string, number | undefined> = {};
    const exec: ExecFn = async (file, args, opts) => {
      if (args[0] === 'fetch') seen.fetch = opts.timeoutMs;
      if (args[0] === 'worktree' && args[1] === 'add') seen.add = opts.timeoutMs;
      return defaultExec(file, args, opts);
    };
    const started = Date.now();
    await expect(
      startRun(
        startOpts(launcher('ok').command, {
          cwd: repo,
          worktree: true,
          exec,
          setup: 'sleep 30',
          start_budget_ms: 1500,
        }),
      ),
    ).rejects.toThrow(/setup command failed|start budget/);
    expect(seen.fetch).toBeLessThanOrEqual(1500);
    expect(seen.add).toBeLessThanOrEqual(1500);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(readdirSync(join(home, 'runs'))).toEqual([]);
  });

  it('a run ended during the start phase is not resurrected and nothing is left behind', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/r');
    const { command, log } = launcher('ok');
    const exec: ExecFn = async (file, args, opts) => {
      const res = await defaultExec(file, args, opts);
      if (args[0] === 'worktree' && args[1] === 'add') {
        // what reconcile does to a run it considers dead
        for (const id of readdirSync(join(home, 'runs'))) updateStatus(id, 'failed_no_report');
      }
      return res;
    };
    await expect(
      startRun(startOpts(command, { cwd: repo, worktree: true, lock_key: 'c', exec })),
    ).rejects.toThrow(/already ended as failed_no_report/);
    expect(existsSync(log)).toBe(false);
    expect(readdirSync(join(home, 'runs'))).toEqual([]);
    expect(existsSync(worktreesDir()) ? readdirSync(worktreesDir()) : []).toEqual([]);
    expect(lockFiles()).toEqual([]);
  });

  it('refuses a lock_key without a worktree run before creating anything', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/l');
    await expect(
      startRun(startOpts(launcher('ok').command, { cwd: repo, worktree: false, lock_key: 'k' })),
    ).rejects.toThrow(/lock_key needs a worktree/);
    await expect(
      startRun(startOpts(launcher('ok').command, { cwd: tmp('plain'), lock_key: 'k' })),
    ).rejects.toThrow(/lock_key needs a worktree/);
    expect(existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')) : []).toEqual([]);
  });
});
