/**
 * Runner design
 *
 * The MCP server process never holds a pipe to the agent. `startRun` spawns a detached
 * supervisor (`node <entry> --supervise <runId>`, own process group, `unref`ed) whose stdout
 * and stderr are a file descriptor on `events.jsonl` opened here. The run spec (including the
 * prompt) is handed to the supervisor on stdin and is never written to disk; the supervisor's
 * environment is the adapter's allowlisted env, so no credential or caller variable reaches it.
 * The supervisor spawns the agent command with a pipe to itself, tees every raw line to
 * `events.jsonl`, parses events through the adapter and, when the agent ends, writes
 * `result.md` and the final status. Because the supervisor is the group leader, cancel and the
 * wall-clock timeout signal the whole group.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, realpathSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { relative, join, isAbsolute } from 'node:path';
import { claudeAdapter, getAdapter, isRateLimitRejected } from './adapters/claude.js';
import { guardPrompt, parseStatusLine, resolveTools } from './guard.js';
import { runDir, wingmanHome } from './paths.js';
import {
  appendEvent,
  createRun,
  pruneEvents,
  patchRunning,
  readMeta,
  updateStatus,
  writeMeta,
  writeResult,
} from './runs.js';
import { isAlive, isSameProcess, readStartTime } from './proc.js';
import { reconcile } from './reconcile.js';
import { assertCanStart, currentDepth } from './self.js';
import { changedSince, takeSnapshot } from './snapshot.js';
import {
  baseBranches,
  createWorktree,
  DEFAULT_SETUP_TIMEOUT_MS,
  START_BUDGET_MS,
  defaultExec,
  releaseLocksOf,
  removeWorktree,
  runSetup,
  setLockOwner,
  type ExecFn,
} from './worktree.js';
import {
  TERMINAL_STATUSES,
  type Account,
  type Adapter,
  type RateLimitInfo,
  type RefSnapshot,
  type RunMeta,
  type RunStatus,
  type StartSpec,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const KILL_GRACE_MS = 3000;
const DRAIN_MS = 2000;
const MAX_EVENTS_BYTES = 20 * 1024 * 1024;

const PLUGIN_COMMAND = /\bclaude\s+plugins?\s+(?:install|update|uninstall)\b/i;
const PLUGIN_UPDATED = /\bplugins?\s+(?:was\s+|were\s+|has\s+been\s+|have\s+been\s+)?updated\b/i;

/** An explicit plugin command, or a sentence that names claude and says a plugin was updated. */
export function reportsPluginChange(text: string): boolean {
  if (PLUGIN_COMMAND.test(text)) return true;
  return text
    .split(/[.!?\n]+/)
    .some((sentence) => /\bclaude\b/i.test(sentence) && PLUGIN_UPDATED.test(sentence));
}

export interface StartRunOptions {
  account: Account;
  prompt: string;
  cwd: string;
  model?: string;
  preset?: string;
  allowed_tools?: string[];
  max_turns?: number;
  worktree?: boolean;
  lock_key?: string;
  parentEnv?: NodeJS.ProcessEnv;
  adapter?: Adapter;
  /** Wall-clock limit for the agent; a hung child is killed and the run is `failed`. */
  timeout_ms?: number;
  /** Shell command run in a fresh worktree before the task. */
  setup?: string;
  /** Script the supervisor is started from; defaults to the running entry (`process.argv[1]`). */
  supervisorEntry?: string;
  exec?: ExecFn;
  sleep?: (ms: number) => Promise<void>;
  /** Per `git fetch` attempt; default 120s. */
  fetch_timeout_ms?: number;
  /** `git worktree add`; default 60s. */
  worktree_timeout_ms?: number;
  /** The setup command; default 600s. */
  setup_timeout_ms?: number;
  /** Total start phase (fetch, worktree add, setup); default 15 min, below reconcile's grace. */
  start_budget_ms?: number;
}

interface SupervisorPayload {
  repo?: string;
  ref_snapshot?: RefSnapshot;
  provider: string;
  command: string;
  args: string[];
  cwd: string;
  timeout_ms: number;
  wingman_home: string;
}

export interface Outcome {
  status: RunStatus;
  text: string;
}

export function mapOutcome(input: {
  finished: { result: string | null; is_error: boolean; max_turns?: boolean } | undefined;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  rateRejected: boolean;
  spawnError?: string;
}): Outcome {
  const { finished, exitCode, timedOut, rateRejected } = input;
  const exit = `exit code ${exitCode ?? 'none'}${input.signal ? `, signal ${input.signal}` : ''}`;
  // a result that arrived before the kill stands; the kill then explains any nonzero exit
  const killedAfterResult = timedOut && finished !== undefined;
  if (timedOut && !killedAfterResult) {
    return {
      status: 'failed',
      text: `[wingman] agent exceeded the time limit and was killed (${exit})`,
    };
  }
  if (!finished) {
    const detail = input.spawnError ? `could not start: ${input.spawnError}` : exit;
    if (rateRejected) {
      return { status: 'rate_limited', text: `[wingman] rate limited before a result (${detail})` };
    }
    return {
      status: 'failed_no_report',
      text: `[wingman] agent ended without a result message (${detail})`,
    };
  }
  if (finished.max_turns) {
    return {
      status: 'partial',
      text:
        finished.result ??
        '[wingman] the agent stopped at its turn limit (max_turns) before finishing',
    };
  }
  const text = finished.result ?? '';
  if (finished.is_error || (!killedAfterResult && exitCode !== null && exitCode !== 0)) {
    if (rateRejected) return { status: 'rate_limited', text };
    return { status: 'failed', text };
  }
  if (reportsPluginChange(text)) return { status: 'needs_caller', text };
  return { status: parseStatusLine(text) ?? 'needs_input', text };
}

const CLEAN_STATUSES: readonly RunStatus[] = ['done', 'partial', 'blocked', 'needs_input'];

/** A run that moved a ref or the local config it must not touch goes back to the caller. */
export function flagGuardrail(outcome: Outcome, changed: ('refs' | 'config')[]): Outcome {
  const what = changed
    .map((c) => (c === 'refs' ? 'the base branch or caller branch ref' : 'the local git config'))
    .join(' and ');
  const note = `[wingman] guardrail: ${what} changed while this run was active (the run, or you, moved it). Review with git before trusting this result.`;
  return {
    status: CLEAN_STATUSES.includes(outcome.status) ? 'needs_caller' : outcome.status,
    text: `${outcome.text}\n\n${note}`,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runSupervisor(runId: string): Promise<void> {
  const payload = JSON.parse(await readStdin()) as SupervisorPayload;
  const childEnv = { ...process.env } as Record<string, string>;
  process.env.WINGMAN_HOME = payload.wingman_home;
  const adapter = getAdapter(payload.provider);

  let sessionRateLimit: RateLimitInfo | undefined;
  let rateRejected = false;
  let finished:
    | {
        result: string | null;
        is_error: boolean;
        permission_denials: string[];
        max_turns?: boolean;
      }
    | undefined;
  let timedOut = false;
  let spawnError: string | undefined;

  const child: ChildProcess = spawn(payload.command, payload.args, {
    cwd: payload.cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const terminateGroup = (): void => {
    try {
      process.kill(-process.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  };
  process.on('SIGTERM', () => {
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  });

  let timer: NodeJS.Timeout | undefined;
  if (payload.timeout_ms > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, payload.timeout_ms);
  }

  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      appendEvent(runId, line);
      for (const event of adapter.parseLine(line)) {
        if (event.kind === 'rate_limited') {
          sessionRateLimit = event.info;
          if (isRateLimitRejected(event.info)) rateRejected = true;
        } else if (event.kind === 'finished') {
          finished = event;
        }
      }
    });
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    appendEvent(
      runId,
      JSON.stringify({ type: 'stderr', text: chunk.toString('utf8').slice(0, 2000) }),
    );
  });
  child.on('error', (err) => {
    spawnError = err.message;
  });

  // `close` waits for every holder of the pipes, so a grandchild that outlives the agent would
  // hang the run: finalize on `exit` once the pipes had a short time to drain.
  const end = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    let settled = false;
    const settle = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.on('close', (code, signal) => settle(code, signal));
    child.on('exit', (code, signal) => {
      setTimeout(() => settle(code, signal), DRAIN_MS).unref();
    });
    child.on('error', () => settle(null, null));
  });
  if (timer) clearTimeout(timer);

  const current = readMeta(runId);
  if (TERMINAL_STATUSES.includes(current.status)) return;
  const input: Parameters<typeof mapOutcome>[0] = {
    finished,
    exitCode: end.code,
    signal: end.signal,
    timedOut,
    rateRejected,
  };
  if (spawnError !== undefined) input.spawnError = spawnError;
  let outcome = mapOutcome(input);
  if (payload.repo && payload.ref_snapshot) {
    const changed = await changedSince(defaultExec, payload.repo, payload.ref_snapshot);
    if (changed.length > 0) outcome = flagGuardrail(outcome, changed);
  }
  writeResult(runId, outcome.text);
  const patch: Partial<Omit<RunMeta, 'id' | 'status'>> = {
    exit_code: end.code,
    permission_denials: [...new Set(finished?.permission_denials ?? [])],
  };
  if (sessionRateLimit) patch.rate_limit = sessionRateLimit;
  try {
    updateStatus(runId, outcome.status, patch);
  } catch {
    // the run was cancelled while we were finalizing; the cancel status stands
  }
  pruneEvents(runId, MAX_EVENTS_BYTES);
}

/**
 * Takes down whatever the agent left behind in the supervisor's process group. The supervisor
 * is the group leader and has a SIGTERM handler, so the first signal spares it; the final
 * SIGKILL ends the supervisor too, which is why it runs only after the run is finalized.
 */
async function reapGroup(): Promise<void> {
  try {
    process.kill(-process.pid, 'SIGTERM');
  } catch {
    return;
  }
  await sleepMs(500);
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    // not a group leader, or the group is already gone
  }
}

/** Call first thing in the process entry; returns true when this process is a supervisor. */
export function maybeRunSupervisor(argv: string[] = process.argv): boolean {
  const index = argv.indexOf('--supervise');
  const runId = index === -1 ? undefined : argv[index + 1];
  if (!runId) return false;
  runSupervisor(runId).then(
    async () => {
      await reapGroup();
      process.exit(0);
    },
    async (err: unknown) => {
      process.stderr.write(
        `supervisor failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      try {
        updateStatus(runId, 'failed_no_report', { exit_code: null });
      } catch {
        // already terminal or run missing
      }
      await reapGroup();
      process.exit(1);
    },
  );
  return true;
}

async function gitOut(exec: ExecFn, cwd: string, args: string[]): Promise<string | undefined> {
  const res = await exec('git', args, { cwd, env: process.env });
  return res.code === 0 ? res.stdout.trim() : undefined;
}

function launchSupervisor(
  meta: RunMeta,
  payload: SupervisorPayload,
  env: Record<string, string>,
  entry: string,
): { pid: number; startTime: string | undefined } {
  const dir = runDir(meta.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(join(dir, 'events.jsonl'), 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [entry, '--supervise', meta.id], {
      detached: true,
      stdio: ['pipe', fd, fd],
      env,
      cwd: payload.cwd,
    });
  } finally {
    closeSync(fd);
  }
  child.on('error', () => {
    try {
      updateStatus(meta.id, 'failed_no_report');
    } catch {
      // already terminal
    }
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('Could not start the supervisor process');
  const startTime = readStartTime(pid);
  const patch: Partial<Omit<RunMeta, 'id' | 'status'>> = {
    pid,
    started_at: new Date().toISOString(),
  };
  if (startTime !== undefined) patch.pid_start_time = startTime;
  try {
    patchRunning(meta.id, patch);
  } catch (err) {
    // the run was ended during start: the supervisor never gets its payload, so stop it
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    throw err;
  }
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(JSON.stringify(payload));
  child.unref();
  return { pid, startTime };
}

export async function startRun(opts: StartRunOptions): Promise<RunMeta> {
  const parentEnv = opts.parentEnv ?? process.env;
  assertCanStart(parentEnv);
  const adapter = opts.adapter ?? claudeAdapter;
  const exec = opts.exec ?? defaultExec;
  const depth = currentDepth(parentEnv) + 1;
  const tools = resolveTools({
    ...(opts.preset !== undefined ? { preset: opts.preset } : {}),
    ...(opts.allowed_tools !== undefined ? { allowed_tools: opts.allowed_tools } : {}),
  });

  const top = await gitOut(exec, opts.cwd, ['rev-parse', '--show-toplevel']);
  const callerBranch = top
    ? await gitOut(exec, top, ['rev-parse', '--abbrev-ref', 'HEAD'])
    : undefined;
  if (top && callerBranch !== undefined) {
    if (callerBranch === 'HEAD') throw new Error('Refusing to start a run on a detached HEAD');
    if ((await baseBranches(exec, top, parentEnv)).includes(callerBranch)) {
      throw new Error(
        `Refusing to start a run on the base branch "${callerBranch}"; switch to a feature branch first`,
      );
    }
  }
  const repo = opts.worktree ? top : undefined;
  if (opts.lock_key !== undefined && !repo) {
    throw new Error('lock_key needs a worktree run inside a git repository');
  }
  const offset = repo ? offsetInRepo(repo, opts.cwd) : '';

  const sessionId = randomUUID();
  const meta = createRun({
    account: opts.account.id,
    cwd: opts.cwd,
    run_cwd: opts.cwd,
    session_id: sessionId,
    depth,
    prompt_chars: opts.prompt.length,
    ...(top !== undefined ? { repo: top } : {}),
    ...(callerBranch !== undefined ? { branch: callerBranch } : {}),
    ...(opts.lock_key !== undefined ? { lock_key: opts.lock_key } : {}),
    ...(opts.preset !== undefined ? { preset: opts.preset } : {}),
  });

  const deadline = Date.now() + (opts.start_budget_ms ?? START_BUDGET_MS);
  let runCwd = opts.cwd;
  let lockPath: string | undefined;
  try {
    if (repo && callerBranch !== undefined) {
      const wt = await createWorktree({
        repo,
        callerBranch,
        runId: meta.id,
        env: parentEnv,
        exec,
        deadline,
        ...(opts.lock_key !== undefined ? { lock_key: opts.lock_key } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.fetch_timeout_ms !== undefined ? { fetchTimeoutMs: opts.fetch_timeout_ms } : {}),
        ...(opts.worktree_timeout_ms !== undefined
          ? { addTimeoutMs: opts.worktree_timeout_ms }
          : {}),
      });
      lockPath = wt.lockPath;
      meta.worktree = wt.path;
      meta.run_branch = wt.branch;
      runCwd = offset ? join(wt.path, offset) : wt.path;
      meta.run_cwd = runCwd;
      patchRunning(meta.id, {
        worktree: wt.path,
        run_branch: wt.branch,
        run_cwd: runCwd,
      });
      if (opts.setup) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('Worktree setup skipped: the start budget is used up');
        const setup = await runSetup(
          wt.path,
          opts.setup,
          adapter.buildEnv(parentEnv, opts.account, depth),
          Math.min(opts.setup_timeout_ms ?? DEFAULT_SETUP_TIMEOUT_MS, left),
        );
        if (!setup.ok)
          throw new Error(`Worktree setup command failed: ${setup.output.slice(-300)}`);
      }
    }
  } catch (err) {
    await discardStart(meta, exec);
    throw err;
  }

  if (top && callerBranch !== undefined) {
    const snapshot = await takeSnapshot(exec, top, callerBranch).catch(() => undefined);
    if (snapshot) {
      meta.ref_snapshot = snapshot;
      patchRunning(meta.id, { ref_snapshot: snapshot });
    }
  }

  const spec: StartSpec = {
    prompt: opts.prompt,
    cwd: runCwd,
    allowed_tools: tools.allowed,
    disallowed_tools: tools.disallowed,
    session_id: sessionId,
    append_system_prompt: guardPrompt(),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.max_turns !== undefined ? { max_turns: opts.max_turns } : {}),
  };
  try {
    return spawnRun(meta, opts, adapter, spec, depth, parentEnv, lockPath);
  } catch (err) {
    await discardStart(meta, exec);
    throw err;
  }
}

/** Offset of `cwd` inside `repo`, from realpaths so a symlinked cwd resolves to the same place. */
function offsetInRepo(repo: string, cwd: string): string {
  const rel = relative(realpathSync(repo), realpathSync(cwd));
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('cwd resolves outside its git repository');
  }
  return rel;
}

/** Undoes a start that failed before the agent ran: worktree, lock and run directory. */
async function discardStart(meta: RunMeta, exec: ExecFn): Promise<void> {
  try {
    updateStatus(meta.id, 'failed_no_report');
  } catch {
    // already terminal or run dir gone
  }
  if (meta.worktree) {
    try {
      // the disk copy may predate the worktree when the start-phase patch was refused
      writeMeta({ ...readMeta(meta.id), worktree: meta.worktree });
    } catch {
      // run dir gone
    }
    await removeWorktree(meta.id, exec).catch(() => undefined);
  }
  releaseLocksOf(meta.id);
  rmSync(runDir(meta.id), { recursive: true, force: true });
}

function spawnRun(
  meta: RunMeta,
  opts: Pick<StartRunOptions, 'account' | 'timeout_ms' | 'supervisorEntry'>,
  adapter: Adapter,
  spec: StartSpec,
  depth: number,
  parentEnv: NodeJS.ProcessEnv,
  lockPath: string | undefined,
): RunMeta {
  const { command, args } = adapter.buildCommand(opts.account, spec);
  const payload: SupervisorPayload = {
    ...(meta.repo !== undefined ? { repo: meta.repo } : {}),
    ...(meta.ref_snapshot !== undefined ? { ref_snapshot: meta.ref_snapshot } : {}),
    provider: adapter.provider,
    command,
    args,
    cwd: spec.cwd,
    timeout_ms: opts.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    wingman_home: wingmanHome(),
  };
  const entry = opts.supervisorEntry ?? process.argv[1];
  try {
    if (!entry) throw new Error('No supervisor entry script');
    const { pid } = launchSupervisor(
      meta,
      payload,
      adapter.buildEnv(parentEnv, opts.account, depth),
      entry,
    );
    if (lockPath) setLockOwner(lockPath, pid);
  } catch (err) {
    try {
      updateStatus(meta.id, 'failed_no_report');
    } catch {
      // already terminal
    }
    releaseLocksOf(meta.id);
    throw err;
  }
  return readMeta(meta.id);
}

export interface CancelResult {
  cancelled: boolean;
  killed: boolean;
  reason?: string;
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function cancelRun(runId: string): Promise<CancelResult> {
  const meta = reconcile(readMeta(runId));
  if (meta.status !== 'running') {
    return { cancelled: false, killed: false, reason: `run is already ${meta.status}` };
  }
  const pid = meta.pid;
  if (pid === undefined)
    return { cancelled: false, killed: false, reason: 'run has no recorded pid' };
  if (!isSameProcess(pid, meta.pid_start_time)) {
    return {
      cancelled: false,
      killed: false,
      reason: 'recorded pid is gone or was reused by another process; nothing was killed',
    };
  }
  try {
    updateStatus(runId, 'cancelled');
  } catch {
    return { cancelled: false, killed: false, reason: 'run finished while cancelling' };
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // group already gone
  }
  const deadline = Date.now() + KILL_GRACE_MS + 1000;
  while (isAlive(pid) && Date.now() < deadline) await sleepMs(50);
  if (isAlive(pid) && isSameProcess(pid, meta.pid_start_time)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // group already gone
    }
  }
  return { cancelled: true, killed: true };
}

export async function waitForRun(
  runId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<RunMeta> {
  const pollMs = opts.pollMs ?? 500;
  const deadline = opts.timeoutMs === undefined ? Infinity : Date.now() + opts.timeoutMs;
  for (;;) {
    const meta = reconcile(readMeta(runId));
    if (TERMINAL_STATUSES.includes(meta.status)) return meta;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for run ${runId}`);
    await sleepMs(pollMs);
  }
}
