import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDir, wingmanHome, worktreesDir } from '../src/paths.js';
import { readMeta } from '../src/runs.js';
import { saveAccounts } from '../src/registry.js';
import { cancelRun, sendToRun, startRun, waitForRun, type StartRunOptions } from '../src/runner.js';
import { createHandlers } from '../src/tools.js';
import {
  defaultExec,
  pruneOrphans,
  removeWorktree,
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
    preset: 'os-apply',
    sleep: noSleep,
    ...extra,
  };
}

async function register(command: string): Promise<void> {
  await saveAccounts({ accounts: [makeAccount(command, join(home, 'cfg-target'))] });
}

const settle = (m: RunMeta): Promise<RunMeta> => waitForRun(m.id, { timeoutMs: 20000, pollMs: 50 });

function lockFiles(): { run_id: string; pid: number }[] {
  const dir = join(wingmanHome(), 'locks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

async function finishedWorktreeRun(change = 'chg'): Promise<{ repo: string; first: RunMeta }> {
  const repo = makeRepo('main');
  git(repo, 'switch', '-q', '-c', 'feat/c');
  const first = await settle(
    await startRun(startOpts(launcher('ok').command, { cwd: repo, worktree: true, change })),
  );
  expect(first.status).toBe('done');
  return { repo, first };
}

describe('worktree ownership across a continued run (H1)', () => {
  it('a continued run blocks cleanup and prune of the shared worktree and owns the lock', async () => {
    const { first } = await finishedWorktreeRun();
    const hang = launcher('hang');
    await register(hang.command);
    const second = await sendToRun(first.id, 'more', { parentEnv: env(), supervisorEntry: entry });
    try {
      expect(second.worktree).toBe(first.worktree);
      const locks = lockFiles();
      expect(locks).toHaveLength(1);
      expect(locks[0]).toMatchObject({ run_id: second.id, pid: second.pid });

      await expect(removeWorktree(first.id)).rejects.toThrow(/still in use/);
      const h = createHandlers({ env: env() });
      await expect(h.cleanup({ run_id: first.id, action: 'discard' })).rejects.toThrow(
        /still in use/,
      );
      expect(await pruneOrphans()).toEqual([]);
      expect(existsSync(first.worktree as string)).toBe(true);
      await expect(sendToRun(first.id, 'again', { parentEnv: env() })).rejects.toThrow(
        /in use by run/,
      );
    } finally {
      await cancelRun(second.id);
      await settle(second);
    }
    const h = createHandlers({ env: env() });
    await h.cleanup({ run_id: first.id, action: 'discard' });
    expect(existsSync(first.worktree as string)).toBe(false);
    expect(lockFiles()).toEqual([]);
  });

  it('a live holder of the change lock other than the previous run blocks the send', async () => {
    const { first } = await finishedWorktreeRun();
    const lockDir = join(wingmanHome(), 'locks');
    const [file] = readdirSync(lockDir);
    writeFileSync(
      join(lockDir, file!),
      JSON.stringify({ pid: process.pid, run_id: 'someone-else', repo: first.repo, change: 'chg' }),
    );
    await register(launcher('ok').command);
    await expect(
      sendToRun(first.id, 'more', { parentEnv: env(), supervisorEntry: entry }),
    ).rejects.toThrow(/already being applied/);
    expect(readdirSync(join(home, 'runs'))).toEqual([first.id]);
  });
});

describe('run_cwd and send (M3)', () => {
  it('stores the effective cwd through a symlinked subdirectory and reuses it on send', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/s');
    const link = join(tmp('link'), 'via');
    symlinkSync(join(repo, 'sub'), link);
    const { command, log } = launcher('ok');
    const first = await settle(await startRun(startOpts(command, { cwd: link, worktree: true })));
    expect(first.run_cwd).toBe(join(first.worktree as string, 'sub'));
    await register(command);
    const second = await settle(
      await sendToRun(first.id, 'more', { parentEnv: env(), supervisorEntry: entry }),
    );
    expect(second.run_cwd).toBe(first.run_cwd);
    const cwds = readLog(log).map((r) => r.cwd);
    expect(cwds[1]).toBe(cwds[0]);
    expect(cwds[1]).toBe(join(first.worktree as string, 'sub'));
  });

  it('refuses to send when the worktree is gone instead of using the caller checkout', async () => {
    const { first } = await finishedWorktreeRun();
    await register(launcher('ok').command);
    await removeWorktree(first.id);
    await expect(
      sendToRun(first.id, 'more', { parentEnv: env(), supervisorEntry: entry }),
    ).rejects.toThrow(/no longer exists/);
    expect(readdirSync(join(home, 'runs'))).toEqual([first.id]);
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
          change: 'c',
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
          change: 'c',
          exec,
          worktree_timeout_ms: 300,
        }),
      ),
    ).rejects.toThrow(/worktree add failed/);
    expect(readdirSync(join(home, 'runs'))).toEqual([]);
    expect(lockFiles()).toEqual([]);
  });

  it('a failed spawn in startRun releases the worktree and lock; in sendToRun the lock', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/f');
    await expect(
      startRun(
        startOpts(launcher('ok').command, {
          cwd: repo,
          worktree: true,
          change: 'c',
          supervisorEntry: '',
        }),
      ),
    ).rejects.toThrow(/supervisor/i);
    expect(lockFiles()).toEqual([]);
    expect(existsSync(worktreesDir()) ? readdirSync(worktreesDir()) : []).toEqual([]);

    const { first } = await finishedWorktreeRun('d');
    await register(launcher('ok').command);
    expect(lockFiles()).toHaveLength(1);
    await expect(
      sendToRun(first.id, 'more', { parentEnv: env(), supervisorEntry: '' }),
    ).rejects.toThrow(/supervisor/i);
    expect(lockFiles()).toEqual([]);
    expect(existsSync(first.worktree as string)).toBe(true);
    for (const id of readdirSync(join(home, 'runs'))) {
      if (id !== first.id) expect(readMeta(id).status).toBe('failed_no_report');
    }
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
