import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runDir, wingmanHome, worktreesDir } from './paths.js';
import { listRuns, readMeta } from './runs.js';
import { TERMINAL_STATUSES } from './types.js';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const FETCH_ATTEMPTS = 5;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export const defaultExec: ExecFn = (file, args, { cwd, env }) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const code = typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout, stderr: stderr || err.message });
    });
  });

export interface CreateWorktreeOptions {
  repo: string;
  callerBranch: string;
  runId: string;
  change?: string;
  exec?: ExecFn;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  lockPath?: string;
  warnings: string[];
}

interface LockInfo {
  pid: number;
  start_time?: string;
  run_id: string;
  repo: string;
  change: string;
}

export function withoutProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of PROXY_VARS) delete copy[name];
  return copy;
}

export function readStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19];
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when pid is alive and, where /proc exposes it, still the process that started at `startTime`. */
export function isSameProcess(pid: number, startTime: string | undefined): boolean {
  if (!isAlive(pid)) return false;
  if (startTime === undefined) return true;
  const actual = readStartTime(pid);
  return actual === undefined || actual === startTime;
}

function locksDir(): string {
  return join(wingmanHome(), 'locks');
}

function lockPathFor(repo: string, change: string): string {
  const key = createHash('sha256')
    .update(`${realpathSync(repo)}\0${change}`)
    .digest('hex');
  return join(locksDir(), `${key.slice(0, 24)}.lock`);
}

function readLock(path: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    return typeof parsed.pid === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function acquireLock(path: string, info: LockInfo): void {
  mkdirSync(locksDir(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const held = readLock(path);
      if (held && isSameProcess(held.pid, held.start_time)) {
        throw new Error(
          `Change "${info.change}" is already being applied by run ${held.run_id} (pid ${held.pid})`,
          { cause: err },
        );
      }
      try {
        unlinkSync(path);
      } catch {
        // another process reclaimed it first; retry the create
      }
    }
  }
  throw new Error(`Could not acquire the lock for change "${info.change}"`);
}

export function setLockOwner(lockPath: string, pid: number): void {
  const held = readLock(lockPath);
  if (!held) return;
  const next: LockInfo = { ...held, pid };
  const startTime = readStartTime(pid);
  if (startTime !== undefined) next.start_time = startTime;
  else delete next.start_time;
  writeFileSync(lockPath, JSON.stringify(next), { mode: 0o600 });
}

function releaseLocksOf(runId: string): void {
  if (!existsSync(locksDir())) return;
  for (const entry of readdirSync(locksDir())) {
    const path = join(locksDir(), entry);
    if (readLock(path)?.run_id === runId) rmSync(path, { force: true });
  }
}

async function withRetry(
  exec: ExecFn,
  sleep: (ms: number) => Promise<void>,
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  let result = await exec(file, args, opts);
  for (let attempt = 1; attempt < FETCH_ATTEMPTS && result.code !== 0; attempt++) {
    if (!`${result.stdout}\n${result.stderr}`.includes('503')) break;
    await sleep(2000);
    result = await exec(file, args, opts);
  }
  return result;
}

async function baseBranches(exec: ExecFn, cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const names = ['main', 'master'];
  const head = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd,
    env,
  });
  if (head.code === 0) names.push(head.stdout.trim().replace(/^origin\//, ''));
  return names;
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
  const exec = opts.exec ?? defaultExec;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = withoutProxy(opts.env ?? process.env);
  const { repo, callerBranch, runId } = opts;

  if (!callerBranch || callerBranch === 'HEAD') {
    throw new Error('Refusing to create a worktree from a detached HEAD');
  }
  if ((await baseBranches(exec, repo, env)).includes(callerBranch)) {
    throw new Error(`Refusing to create a worktree from the base branch "${callerBranch}"`);
  }

  let lockPath: string | undefined;
  if (opts.change) {
    lockPath = lockPathFor(repo, opts.change);
    const info: LockInfo = {
      pid: process.pid,
      run_id: runId,
      repo,
      change: opts.change,
    };
    const startTime = readStartTime(process.pid);
    if (startTime !== undefined) info.start_time = startTime;
    acquireLock(lockPath, info);
  }

  try {
    const warnings: string[] = [];
    const fetched = await withRetry(exec, sleep, 'git', ['fetch', 'origin'], { cwd: repo, env });
    if (fetched.code !== 0) {
      warnings.push(`git fetch failed (code ${fetched.code}); worktree cut from local HEAD`);
    }

    mkdirSync(worktreesDir(), { recursive: true, mode: 0o700 });
    chmodSync(worktreesDir(), 0o700);
    const path = join(worktreesDir(), runId);
    const branch = `${callerBranch}-wm-${runId}`;
    const added = await withRetry(
      exec,
      sleep,
      'git',
      ['worktree', 'add', '-b', branch, path, 'HEAD'],
      { cwd: repo, env },
    );
    if (added.code !== 0) {
      throw new Error(`git worktree add failed: ${added.stderr.trim().slice(0, 500)}`);
    }
    const info: WorktreeInfo = { path, branch, warnings };
    if (lockPath) info.lockPath = lockPath;
    return info;
  } catch (err) {
    if (lockPath) rmSync(lockPath, { force: true });
    throw err;
  }
}

export async function runSetup(
  worktree: string,
  command?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; output: string }> {
  if (!command) return { ok: true, output: '' };
  const result = await defaultExec('sh', ['-c', command], { cwd: worktree, env });
  return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.slice(-2000) };
}

export async function removeWorktree(runId: string, exec: ExecFn = defaultExec): Promise<void> {
  const meta = readMeta(runId);
  if (meta.worktree && existsSync(meta.worktree)) {
    const env = withoutProxy(process.env);
    const removed = await exec('git', ['worktree', 'remove', '--force', meta.worktree], {
      cwd: meta.cwd,
      env,
    });
    if (removed.code !== 0 && meta.worktree.startsWith(worktreesDir())) {
      rmSync(meta.worktree, { recursive: true, force: true });
    }
    await exec('git', ['worktree', 'prune'], { cwd: meta.cwd, env });
  }
  releaseLocksOf(runId);
}

/** Removes worktrees of runs that are terminal (and finished at least `minAgeMs` ago) or whose process is gone. */
export async function pruneOrphans(
  opts: { minAgeMs?: number; exec?: ExecFn } = {},
): Promise<string[]> {
  const removed: string[] = [];
  const minAge = opts.minAgeMs ?? 0;
  for (const meta of listRuns()) {
    if (!meta.worktree || !existsSync(meta.worktree) || !existsSync(runDir(meta.id))) continue;
    const terminal = TERMINAL_STATUSES.includes(meta.status);
    const dead = meta.pid !== undefined && !isSameProcess(meta.pid, meta.pid_start_time);
    if (!terminal && !dead) continue;
    if (terminal && minAge > 0 && meta.finished_at) {
      if (Date.now() - Date.parse(meta.finished_at) < minAge) continue;
    }
    await removeWorktree(meta.id, opts.exec);
    removed.push(meta.id);
  }
  return removed;
}
