import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { wingmanHome } from '../src/paths.js';
import { join } from 'node:path';
import { worktreesDir } from '../src/paths.js';
import { groupMembers } from '../src/proc.js';
import type { RunMeta } from '../src/types.js';
import { createRun, readMeta, updateStatus, writeMeta } from '../src/runs.js';
import {
  acquireLock,
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
  it('refuses a detached HEAD', async () => {
    const repo = makeRepo('main');
    await expect(createWorktree({ repo, callerBranch: 'HEAD', runId: 'r1' })).rejects.toThrow(
      /detached/,
    );
    expect(existsSync(join(worktreesDir(), 'r1'))).toBe(false);
  });

  it('from a base branch cuts a wingman/<id> branch and leaves the base branch alone', async () => {
    const repo = makeRepo('main');
    const head = git(repo, 'rev-parse', 'HEAD');
    const wt = await createWorktree({ repo, callerBranch: 'main', runId: 'r1', sleep: noSleep });
    expect(wt.branch).toBe('wingman/r1');
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'rev-parse', 'main')).toBe(head);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('createBranch:false gives a detached worktree and no branch', async () => {
    const repo = makeRepo('main');
    const before = git(repo, 'branch', '--format=%(refname:short)');
    const wt = await createWorktree({
      repo,
      callerBranch: 'main',
      runId: 'r2',
      createBranch: false,
      sleep: noSleep,
    });
    expect(wt.branch).toBeUndefined();
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(repo, 'branch', '--format=%(refname:short)')).toBe(before);
  });

  it('treats the origin/HEAD target as a base branch even when it has another name', async () => {
    const repo = makeRepo('trunk');
    git(repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    const wt = await createWorktree({ repo, callerBranch: 'trunk', runId: 'r1', sleep: noSleep });
    expect(wt.branch).toBe('wingman/r1');
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
      lock_key: 'add-x',
      sleep: noSleep,
    });
    writeMeta({ ...meta, worktree: first.path });
    await expect(
      createWorktree({
        repo,
        callerBranch: 'feat/l',
        runId: 'other',
        lock_key: 'add-x',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/already held/);
    const second = await createWorktree({
      repo,
      callerBranch: 'feat/l',
      runId: 'third',
      lock_key: 'add-y',
      sleep: noSleep,
    });
    expect(existsSync(second.path)).toBe(true);
    await removeWorktree(meta.id);
    expect(existsSync(first.path)).toBe(false);
    const again = await createWorktree({
      repo,
      callerBranch: 'feat/l',
      runId: 'fourth',
      lock_key: 'add-x',
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
      lock_key: 'c',
      sleep: noSleep,
    });
    const dead = spawnSync(process.execPath, ['-e', '0']);
    expect(dead.pid).toBeGreaterThan(0);
    writeFileSync(
      first.lockPath as string,
      JSON.stringify({ pid: dead.pid, run_id: 'dead1', repo, lock_key: 'c' }),
    );
    const second = await createWorktree({
      repo,
      callerBranch: 'feat/s',
      runId: 'live2',
      lock_key: 'c',
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
    const mk = async (key: string): Promise<{ id: string; path: string }> => {
      const m = createRun({ account: 'a', cwd: repo, session_id: 's', depth: 1, prompt_chars: 1 });
      const wt = await createWorktree({
        repo,
        callerBranch: 'feat/p',
        runId: m.id,
        lock_key: key,
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

describe('pruneOrphans keep and remove rules', () => {
  async function runWithWorktree(
    repo: string,
    patch: Partial<RunMeta> = {},
  ): Promise<{ id: string; path: string }> {
    const m = createRun({ account: 'a', cwd: repo, session_id: 's', depth: 1, prompt_chars: 1 });
    const wt = await createWorktree({ repo, callerBranch: 'feat/k', runId: m.id, sleep: noSleep });
    writeMeta({ ...readMeta(m.id), worktree: wt.path, ...patch });
    return { id: m.id, path: wt.path };
  }
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid;
  let repo: string;
  beforeEach(() => {
    repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/k');
  });

  it('keeps a terminal run younger than minAge, removes it once old enough', async () => {
    const run = await runWithWorktree(repo);
    updateStatus(run.id, 'done');
    expect(await pruneOrphans({ minAgeMs: 3_600_000 })).toEqual([]);
    expect(existsSync(run.path)).toBe(true);
    expect(await pruneOrphans({ minAgeMs: 0 })).toEqual([run.id]);
  });

  it('keeps a dirty worktree', async () => {
    const run = await runWithWorktree(repo);
    updateStatus(run.id, 'done');
    writeFileSync(join(run.path, 'wip.txt'), 'x');
    expect(await pruneOrphans()).toEqual([]);
    expect(existsSync(run.path)).toBe(true);
  });

  it('removes the worktree of a run whose supervisor died, whatever minAge says', async () => {
    const run = await runWithWorktree(repo, { pid: deadPid() });
    expect(await pruneOrphans({ minAgeMs: 3_600_000 })).toEqual([run.id]);
    expect(existsSync(run.path)).toBe(false);
  });

  it('keeps a worktree another live run still uses', async () => {
    const first = await runWithWorktree(repo);
    updateStatus(first.id, 'done');
    const live = createRun({ account: 'a', cwd: repo, session_id: 's', depth: 1, prompt_chars: 1 });
    writeMeta({ ...readMeta(live.id), worktree: first.path, pid: process.pid });
    expect(await pruneOrphans()).toEqual([]);
    expect(existsSync(first.path)).toBe(true);
  });

  it('keeps a worktree while an agent of the dead supervisor group still runs', async () => {
    const leader = spawn('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!; exit 0'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    leader.stdout.on('data', (d) => (out += d));
    await new Promise((r) => leader.on('close', r));
    const agent = Number(out.trim());
    const run = await runWithWorktree(repo, { pid: leader.pid as number });
    updateStatus(run.id, 'failed_no_report');
    try {
      expect(await pruneOrphans()).toEqual([]);
      expect(existsSync(run.path)).toBe(true);
    } finally {
      process.kill(agent, 'SIGKILL');
    }
    for (let i = 0; i < 50 && groupMembers(leader.pid as number).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await pruneOrphans()).toEqual([run.id]);
  });
});

describe('stale lock reclaim (L2)', () => {
  const info = (run_id: string, pid: number) => ({ pid, run_id, repo: '/r', lock_key: 'c' });

  it('reclaims a dead lock once and leaves no stale files behind', () => {
    const path = join(wingmanHome(), 'locks', 'k.lock');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    acquireLock(path, info('old', dead));
    acquireLock(path, info('first', process.pid));
    expect(() => acquireLock(path, info('second', process.pid))).toThrow(
      /already held by run first/,
    );
    expect(readdirSync(join(wingmanHome(), 'locks'))).toEqual(['k.lock']);
  });

  it('a live lock written by the reclaimer that won is never removed by the loser', () => {
    const path = join(wingmanHome(), 'locks', 'race.lock');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    acquireLock(path, info('old', dead));
    acquireLock(path, info('winner', process.pid));
    expect(() => acquireLock(path, info('loser', process.pid))).toThrow(/already held/);
    expect(JSON.parse(readFileSync(path, 'utf8')).run_id).toBe('winner');
  });
});
