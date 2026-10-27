import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { worktreesDir } from '../src/paths.js';
import { createRun, readMeta, updateStatus, writeMeta } from '../src/runs.js';
import {
  createWorktree,
  pruneOrphans,
  removeWorktree,
  runSetup,
  type ExecFn,
} from '../src/worktree.js';
import { git, makeRepo, tmp } from './helpers.js';

let home: string;
let saved: string | undefined;
const noSleep = (): Promise<void> => Promise.resolve();

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

describe('createWorktree', () => {
  it('refuses the base branch and a detached HEAD', async () => {
    const repo = makeRepo('main');
    await expect(createWorktree({ repo, callerBranch: 'main', runId: 'r1' })).rejects.toThrow(
      /base branch/,
    );
    await expect(createWorktree({ repo, callerBranch: 'master', runId: 'r1' })).rejects.toThrow(
      /base branch/,
    );
    await expect(createWorktree({ repo, callerBranch: 'HEAD', runId: 'r1' })).rejects.toThrow(
      /detached/,
    );
    expect(existsSync(join(worktreesDir(), 'r1'))).toBe(false);
  });

  it('refuses the origin/HEAD target even when it has another name', async () => {
    const repo = makeRepo('trunk');
    git(repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    await expect(createWorktree({ repo, callerBranch: 'trunk', runId: 'r1' })).rejects.toThrow(
      /base branch/,
    );
  });

  it('cuts the run branch from the caller HEAD under worktreesDir', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/x');
    writeFileSync(join(repo, 'change.txt'), 'c');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'caller work');
    const head = git(repo, 'rev-parse', 'HEAD');
    const wt = await createWorktree({
      repo,
      callerBranch: 'feat/x',
      runId: 'abc123',
      sleep: noSleep,
    });
    expect(wt.path).toBe(join(worktreesDir(), 'abc123'));
    expect(wt.branch).toBe('feat/x-wm-abc123');
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(wt.path, 'change.txt'))).toBe(true);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/x');
    expect(wt.warnings.join(' ')).toMatch(/fetch failed/);
  });

  it('retries on 503 with proxy variables removed, and a failed fetch is only a warning', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/y');
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let fetches = 0;
    const exec: ExecFn = async (file, args, opts) => {
      calls.push({ args, env: opts.env });
      if (args[0] === 'fetch') {
        fetches++;
        return { code: 128, stdout: '', stderr: 'RPC failed; HTTP 503' };
      }
      const res = spawnSync(file, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8' });
      return { code: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
    };
    const sleeps: number[] = [];
    const wt = await createWorktree({
      repo,
      callerBranch: 'feat/y',
      runId: 'r503',
      exec,
      sleep: async (ms) => void sleeps.push(ms),
      env: {
        PATH: process.env.PATH,
        HTTPS_PROXY: 'p',
        https_proxy: 'p',
        HTTP_PROXY: 'p',
        http_proxy: 'p',
        NO_PROXY: 'n',
      },
    });
    expect(fetches).toBe(5);
    expect(sleeps).toHaveLength(4);
    for (const call of calls) {
      expect(call.env.HTTPS_PROXY).toBeUndefined();
      expect(call.env.https_proxy).toBeUndefined();
      expect(call.env.HTTP_PROXY).toBeUndefined();
      expect(call.env.http_proxy).toBeUndefined();
      expect(call.env.NO_PROXY).toBe('n');
    }
    expect(existsSync(wt.path)).toBe(true);
    expect(wt.warnings.join(' ')).toMatch(/fetch failed/);
  });

  it('does not retry a non-503 failure', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/z');
    let fetches = 0;
    const exec: ExecFn = async (file, args, opts) => {
      if (args[0] === 'fetch') {
        fetches++;
        return { code: 128, stdout: '', stderr: 'no remote' };
      }
      const res = spawnSync(file, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8' });
      return { code: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
    };
    await createWorktree({ repo, callerBranch: 'feat/z', runId: 'rn', exec, sleep: noSleep });
    expect(fetches).toBe(1);
  });
});

describe('lock', () => {
  it('blocks a second worktree on the same change and releases on remove', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/l');
    const meta = createRun({ account: 'a', cwd: repo, session_id: 's', depth: 1, prompt_chars: 1 });
    const first = await createWorktree({
      repo,
      callerBranch: 'feat/l',
      runId: meta.id,
      change: 'add-x',
      sleep: noSleep,
    });
    writeMeta({ ...meta, worktree: first.path });
    await expect(
      createWorktree({
        repo,
        callerBranch: 'feat/l',
        runId: 'other',
        change: 'add-x',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/already being applied/);
    const second = await createWorktree({
      repo,
      callerBranch: 'feat/l',
      runId: 'third',
      change: 'add-y',
      sleep: noSleep,
    });
    expect(existsSync(second.path)).toBe(true);
    await removeWorktree(meta.id);
    expect(existsSync(first.path)).toBe(false);
    const again = await createWorktree({
      repo,
      callerBranch: 'feat/l',
      runId: 'fourth',
      change: 'add-x',
      sleep: noSleep,
    });
    expect(existsSync(again.path)).toBe(true);
  });

  it('reclaims a lock held by a dead pid', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/s');
    const first = await createWorktree({
      repo,
      callerBranch: 'feat/s',
      runId: 'dead1',
      change: 'c',
      sleep: noSleep,
    });
    const dead = spawnSync(process.execPath, ['-e', '0']);
    expect(dead.pid).toBeGreaterThan(0);
    writeFileSync(
      first.lockPath as string,
      JSON.stringify({ pid: dead.pid, run_id: 'dead1', repo, change: 'c' }),
    );
    const second = await createWorktree({
      repo,
      callerBranch: 'feat/s',
      runId: 'live2',
      change: 'c',
      sleep: noSleep,
    });
    expect(existsSync(second.path)).toBe(true);
  });
});

describe('setup and prune', () => {
  it('runs a setup command in the worktree and reports failure', async () => {
    const dir = tmp('setup');
    expect((await runSetup(dir)).ok).toBe(true);
    const ok = await runSetup(dir, 'echo hi > made.txt');
    expect(ok.ok).toBe(true);
    expect(existsSync(join(dir, 'made.txt'))).toBe(true);
    expect((await runSetup(dir, 'exit 3')).ok).toBe(false);
  });

  it('prunes worktrees of terminal runs and dead pids, keeps live ones', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/p');
    const mk = async (change: string): Promise<{ id: string; path: string }> => {
      const m = createRun({ account: 'a', cwd: repo, session_id: 's', depth: 1, prompt_chars: 1 });
      const wt = await createWorktree({
        repo,
        callerBranch: 'feat/p',
        runId: m.id,
        change,
        sleep: noSleep,
      });
      writeMeta({ ...readMeta(m.id), worktree: wt.path, pid: process.pid });
      return { id: m.id, path: wt.path };
    };
    const live = await mk('live');
    const done = await mk('done');
    updateStatus(done.id, 'done');
    const gone = await mk('gone');
    const dead = spawnSync(process.execPath, ['-e', '0']);
    writeMeta({ ...readMeta(gone.id), pid: dead.pid });
    const removed = await pruneOrphans();
    expect(removed.sort()).toEqual([done.id, gone.id].sort());
    expect(existsSync(live.path)).toBe(true);
    expect(existsSync(done.path)).toBe(false);
    expect(readdirSync(worktreesDir())).toEqual([live.id]);
  });
});
