import { spawn } from 'node:child_process';
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
import { isAlive, isSameProcess, readStartTime } from './proc.js';
import { reconcile } from './reconcile.js';
import { listRuns, readMeta } from './runs.js';
import { TERMINAL_STATUSES, type RunMeta } from './types.js';

export { isAlive, isSameProcess, readStartTime };

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
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<ExecResult>;

export const TIMED_OUT = 124;
const MAX_OUTPUT = 16 * 1024 * 1024;

/**
 * Runs the command in its own process group so a timeout kills the whole tree (a `sh -c` setup
 * command would otherwise leave grandchildren holding the output pipes open).
 */
export const defaultExec: ExecFn = (file, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let hardStop: NodeJS.Timeout | undefined;
    const child = spawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      if (timedOut) stderr = `${stderr}\ntimed out after ${timeoutMs}ms`.trim();
      resolve({ code: timedOut ? TIMED_OUT : code, stdout, stderr });
    };
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      stderr = stderr || err.message;
      settle(typeof err.code === 'number' ? err.code : 127);
    });
    child.on('close', (code) => settle(code ?? 1));
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        hardStop = setTimeout(() => settle(TIMED_OUT), 1000);
      }, timeoutMs);
    }
  });

export interface CreateWorktreeOptions {
  repo: string;
  callerBranch: string;
  runId: string;
  change?: string;
  exec?: ExecFn;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Per attempt; default 120s. */
  fetchTimeoutMs?: number;
  /** Default 60s. */
  addTimeoutMs?: number;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
export const DEFAULT_ADD_TIMEOUT_MS = 60_000;
export const DEFAULT_SETUP_TIMEOUT_MS = 600_000;

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

function acquireLock(path: string, info: LockInfo, ownedBy?: string): void {
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
      if (held && held.run_id !== ownedBy && isSameProcess(held.pid, held.start_time)) {
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

/** Re-points the change lock of a finished run at the run that continues it. */
export function takeOverLock(
  repo: string,
  change: string,
  fromRunId: string,
  toRunId: string,
): string {
  const path = lockPathFor(repo, change);
  const info: LockInfo = { pid: process.pid, run_id: toRunId, repo, change };
  const startTime = readStartTime(process.pid);
  if (startTime !== undefined) info.start_time = startTime;
  acquireLock(path, info, fromRunId);
  return path;
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

export function releaseLocksOf(runId: string): void {
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
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ExecResult> {
  let result = await exec(file, args, opts);
  for (let attempt = 1; attempt < FETCH_ATTEMPTS && result.code !== 0; attempt++) {
    if (!`${result.stdout}\n${result.stderr}`.includes('503')) break;
    await sleep(2000);
    result = await exec(file, args, opts);
  }
  return result;
}

export async function baseBranches(
  exec: ExecFn,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
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
    const fetched = await withRetry(exec, sleep, 'git', ['fetch', 'origin'], {
      cwd: repo,
      env,
      timeoutMs: opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    });
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
      { cwd: repo, env, timeoutMs: opts.addTimeoutMs ?? DEFAULT_ADD_TIMEOUT_MS },
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
  timeoutMs: number = DEFAULT_SETUP_TIMEOUT_MS,
): Promise<{ ok: boolean; output: string }> {
  if (!command) return { ok: true, output: '' };
  const result = await defaultExec('sh', ['-c', command], { cwd: worktree, env, timeoutMs });
  return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.slice(-2000) };
}

/** Non-terminal runs, other than `exceptRunId`, that are working in `worktree`. */
export function activeUsersOf(worktree: string, exceptRunId: string): RunMeta[] {
  return listRuns()
    .filter((m) => m.id !== exceptRunId && m.worktree === worktree)
    .map((m) => reconcile(m))
    .filter((m) => !TERMINAL_STATUSES.includes(m.status));
}

/** True when the worktree has uncommitted changes, or when that cannot be determined. */
export async function worktreeDirty(path: string, exec: ExecFn = defaultExec): Promise<boolean> {
  const res = await exec('git', ['status', '--porcelain'], {
    cwd: path,
    env: withoutProxy(process.env),
    timeoutMs: DEFAULT_ADD_TIMEOUT_MS,
  });
  return res.code !== 0 || res.stdout.trim() !== '';
}

/** Removes the run's worktree and releases its change lock; refuses while another run still uses the worktree. */
export async function removeWorktree(runId: string, exec: ExecFn = defaultExec): Promise<void> {
  const meta = readMeta(runId);
  const sharing = meta.worktree ? listRuns().filter((m) => m.worktree === meta.worktree) : [];
  if (meta.worktree) {
    const busy = activeUsersOf(meta.worktree, runId);
    if (busy.length > 0) {
      throw new Error(
        `Worktree of run ${runId} is still in use by run ${busy[0]!.id} (${busy[0]!.status})`,
      );
    }
  }
  if (meta.worktree && existsSync(meta.worktree)) {
    const env = withoutProxy(process.env);
    const removed = await exec('git', ['worktree', 'remove', '--force', meta.worktree], {
      cwd: meta.cwd,
      env,
      timeoutMs: DEFAULT_ADD_TIMEOUT_MS,
    });
    if (removed.code !== 0 && meta.worktree.startsWith(worktreesDir())) {
      rmSync(meta.worktree, { recursive: true, force: true });
    }
    await exec('git', ['worktree', 'prune'], {
      cwd: meta.cwd,
      env,
      timeoutMs: DEFAULT_ADD_TIMEOUT_MS,
    });
  }
  releaseLocksOf(runId);
  for (const m of sharing) releaseLocksOf(m.id);
}

/**
 * Removes worktrees of runs that are terminal (and finished at least `minAgeMs` ago) or whose
 * supervisor is gone. Skips worktrees with uncommitted changes and worktrees another live run uses.
 */
export async function pruneOrphans(
  opts: { minAgeMs?: number; exec?: ExecFn } = {},
): Promise<string[]> {
  const removed: string[] = [];
  const minAge = opts.minAgeMs ?? 0;
  for (const listed of listRuns()) {
    if (!listed.worktree || !existsSync(listed.worktree) || !existsSync(runDir(listed.id)))
      continue;
    const meta = reconcile(listed);
    const terminal = TERMINAL_STATUSES.includes(meta.status);
    const wasDead = listed.status === 'running' && terminal;
    if (!terminal) continue;
    if (!wasDead && minAge > 0 && meta.finished_at) {
      if (Date.now() - Date.parse(meta.finished_at) < minAge) continue;
    }
    if (await worktreeDirty(meta.worktree as string, opts.exec)) continue;
    try {
      await removeWorktree(meta.id, opts.exec);
    } catch {
      continue;
    }
    removed.push(meta.id);
  }
  return removed;
}
