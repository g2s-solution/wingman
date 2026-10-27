import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  linkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { maskSecrets, safeSummary } from './mask.js';
import { runDir, wingmanHome, worktreesDir } from './paths.js';
import { groupMembers, isAlive, isSameProcess, readStartTime } from './proc.js';
import { reconcile, supervisorGone } from './reconcile.js';
import { listRuns, readMeta } from './runs.js';
import { TERMINAL_STATUSES, type RunMeta } from './types.js';

export { isAlive, isSameProcess, readStartTime };

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

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
  lock_key?: string;
  /** Create a run branch (default). False gives a detached worktree for runs that never commit. */
  createBranch?: boolean;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  /** Default 60s. */
  addTimeoutMs?: number;
  /** Epoch ms by which the start phase must be over; `git worktree add` is cut short or skipped. */
  deadline?: number;
}

export const DEFAULT_ADD_TIMEOUT_MS = 60_000;
export const DEFAULT_SETUP_TIMEOUT_MS = 600_000;
/** Cap on the whole start phase (worktree add, setup); reconcile's no-pid grace is longer. */
export const START_BUDGET_MS = 15 * 60 * 1000;

export interface WorktreeInfo {
  path: string;
  /** Absent for a detached worktree. */
  branch?: string;
  lockPath?: string;
}

export interface LockInfo {
  pid: number;
  start_time?: string;
  run_id: string;
  repo: string;
  lock_key: string;
}

export function withoutProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of PROXY_VARS) delete copy[name];
  return copy;
}

export function locksDir(): string {
  return join(wingmanHome(), 'locks');
}

function lockPathFor(repo: string, lockKey: string): string {
  const key = createHash('sha256')
    .update(`${realpathSync(repo)}\0${lockKey}`)
    .digest('hex');
  return join(locksDir(), `${key.slice(0, 24)}.lock`);
}

export function readLock(path: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    return typeof parsed.pid === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates the lock with O_EXCL. A stale lock is reclaimed by renaming it to a unique name first,
 * so of several reclaimers only the one whose rename succeeds goes on to create the new lock.
 */
export function acquireLock(path: string, info: LockInfo): void {
  mkdirSync(locksDir(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
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
          `Lock key "${info.lock_key}" is already held by run ${held.run_id} (pid ${held.pid})`,
          { cause: err },
        );
      }
      const aside = `${path}.stale-${randomBytes(4).toString('hex')}`;
      try {
        renameSync(path, aside);
      } catch {
        continue; // another reclaimer moved it first; look again
      }
      const moved = readLock(aside);
      if (held && moved && (moved.run_id !== held.run_id || moved.pid !== held.pid)) {
        // we moved a fresh lock created after our read: put it back and give way
        try {
          linkSync(aside, path);
        } catch {
          // the path was taken again; the fresh holder is lost only if it was never re-created
        }
        rmSync(aside, { force: true });
        throw new Error(`Lock key "${info.lock_key}" is already held by run ${moved.run_id}`, {
          cause: err,
        });
      }
      rmSync(aside, { force: true });
    }
  }
  throw new Error(`Could not acquire the lock for key "${info.lock_key}"`);
}

export function setLockOwner(lockPath: string, pid: number): void {
  const held = readLock(lockPath);
  if (!held) return;
  const next: LockInfo = { ...held, pid };
  const startTime = readStartTime(pid);
  if (startTime !== undefined) next.start_time = startTime;
  else delete next.start_time;
  // rename keeps a concurrent reclaimer from ever reading a half-written lock
  const tmp = `${lockPath}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, lockPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function releaseLocksOf(runId: string): void {
  if (!existsSync(locksDir())) return;
  for (const entry of readdirSync(locksDir())) {
    const path = join(locksDir(), entry);
    if (readLock(path)?.run_id === runId) rmSync(path, { force: true });
  }
}

/** Runs `git` under the start budget: each call gets at most the time left, none once it is gone. */
async function execWithinBudget(
  exec: ExecFn,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  deadline?: number,
): Promise<ExecResult> {
  let timeoutMs = opts.timeoutMs;
  if (deadline !== undefined) {
    const left = deadline - Date.now();
    if (left <= 0) return { code: TIMED_OUT, stdout: '', stderr: 'start budget exhausted' };
    timeoutMs = Math.min(timeoutMs, left);
  }
  return exec('git', args, { ...opts, timeoutMs });
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
  const env = withoutProxy(opts.env ?? process.env);
  const { repo, callerBranch, runId } = opts;

  if (!callerBranch || callerBranch === 'HEAD') {
    throw new Error('Refusing to create a worktree from a detached HEAD');
  }
  const fromBase = (await baseBranches(exec, repo, env)).includes(callerBranch);

  let lockPath: string | undefined;
  if (opts.lock_key) {
    lockPath = lockPathFor(repo, opts.lock_key);
    const info: LockInfo = {
      pid: process.pid,
      run_id: runId,
      repo,
      lock_key: opts.lock_key,
    };
    const startTime = readStartTime(process.pid);
    if (startTime !== undefined) info.start_time = startTime;
    acquireLock(lockPath, info);
  }

  try {
    mkdirSync(worktreesDir(), { recursive: true, mode: 0o700 });
    chmodSync(worktreesDir(), 0o700);
    const path = join(worktreesDir(), runId);
    // A run from a base branch gets its own `wingman/` branch so it never shares a name with it.
    const branch =
      opts.createBranch === false
        ? undefined
        : fromBase
          ? `wingman/${runId}`
          : `${callerBranch}-wm-${runId}`;
    const added = await execWithinBudget(
      exec,
      branch === undefined
        ? ['worktree', 'add', '--detach', path, 'HEAD']
        : ['worktree', 'add', '-b', branch, path, 'HEAD'],
      { cwd: repo, env, timeoutMs: opts.addTimeoutMs ?? DEFAULT_ADD_TIMEOUT_MS },
      opts.deadline,
    );
    if (added.code !== 0) {
      throw new Error(`git worktree add failed: ${safeSummary(added.stderr.trim(), 500)}`);
    }
    const info: WorktreeInfo = { path };
    if (branch !== undefined) info.branch = branch;
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
  // mask the whole output before keeping its tail: a cut inside a secret would hide it from the patterns
  const output = maskSecrets(`${result.stdout}${result.stderr}`).slice(-2000);
  return { ok: result.code === 0, output };
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

/** Removes the run's worktree and releases its lock; refuses while another run still uses the worktree. */
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
  opts: { minAgeMs?: number; exec?: ExecFn; dryRun?: boolean } = {},
): Promise<string[]> {
  const removed: string[] = [];
  const minAge = opts.minAgeMs ?? 0;
  const seen = new Set<string>();
  for (const listed of listRuns()) {
    if (!listed.worktree || !existsSync(listed.worktree) || !existsSync(runDir(listed.id)))
      continue;
    // a dry run must not persist anything, so it judges a dead run without ending it
    const meta = opts.dryRun ? peekReconciled(listed) : reconcile(listed);
    const terminal = TERMINAL_STATUSES.includes(meta.status);
    const wasDead = listed.status === 'running' && terminal;
    if (!terminal) continue;
    if (!wasDead && minAge > 0 && meta.finished_at) {
      if (Date.now() - Date.parse(meta.finished_at) < minAge) continue;
    }
    // an agent can outlive its supervisor in the same process group
    if (meta.pid !== undefined && groupMembers(meta.pid).length > 0) continue;
    if (await worktreeDirty(meta.worktree as string, opts.exec)) continue;
    if (opts.dryRun) {
      // runs sharing one worktree would be removed together; count each worktree once
      if (seen.has(meta.worktree as string)) continue;
      seen.add(meta.worktree as string);
      removed.push(meta.id);
      continue;
    }
    try {
      await removeWorktree(meta.id, opts.exec);
    } catch {
      continue;
    }
    removed.push(meta.id);
  }
  return removed;
}

/** The run as reconcile would leave it, without writing anything or touching the process group. */
export function peekReconciled(meta: RunMeta): RunMeta {
  if (meta.status !== 'running' || !supervisorGone(meta)) return meta;
  return {
    ...meta,
    status: 'failed_no_report',
    finished_at: meta.finished_at ?? new Date().toISOString(),
  };
}
