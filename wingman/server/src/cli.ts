import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDeps, doctorCommand, type DoctorDeps } from './doctor.js';
import { DEFAULT_OLDER_THAN_DAYS, runGc } from './gc.js';
import { runDir } from './paths.js';
import { groupMembers } from './proc.js';
import { reconcile, supervisorGone } from './reconcile.js';
import { writeResult } from './runs.js';
import { TERMINAL_STATUSES, type RunMeta } from './types.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMMANDS = ['wait', 'gc', 'doctor'];
const NO_RESULT_TEXT = '[wingman] the run ended without a result message (supervisor gone)';
const ORPHAN_DRAIN_MS = 3500;

const WAIT_USAGE = 'usage: wingman wait <run_id> [--timeout-ms N] [--poll-ms N] [--grace-ms N]';
const GC_USAGE = 'usage: wingman gc [--older-than-days N] [--dry-run]';

class UsageError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs a CLI subcommand and returns its exit code, or undefined when argv is not a CLI call. */
export async function maybeRunCli(
  argv: string[],
  doctorDeps: DoctorDeps = defaultDeps(),
): Promise<number | undefined> {
  const [command, ...args] = argv.slice(2);
  if (command === undefined || !COMMANDS.includes(command)) return undefined;
  try {
    if (command === 'doctor') return await doctorCommand(args, doctorDeps);
    return command === 'wait' ? await waitCommand(args) : await gcCommand(args);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`wingman ${command}: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`wingman ${command}: ${(err as Error).message}\n`);
    return 1;
  }
}

function numberOption(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n < 0) {
    throw new UsageError(
      `${flag} needs a non-negative number\n${flag.startsWith('--older') ? GC_USAGE : WAIT_USAGE}`,
    );
  }
  return n;
}

interface WaitOptions {
  id: string;
  timeoutMs: number;
  pollMs: number;
  graceMs: number;
}

function parseWait(args: string[]): WaitOptions {
  let id: string | undefined;
  const opt = { timeoutMs: 0, pollMs: 1000, graceMs: 5000 };
  const flags: Record<string, keyof typeof opt> = {
    '--timeout-ms': 'timeoutMs',
    '--poll-ms': 'pollMs',
    '--grace-ms': 'graceMs',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const key = flags[a];
    if (key !== undefined) {
      opt[key] = numberOption(a, args[++i]);
    } else if (a.startsWith('-') || id !== undefined) {
      throw new UsageError(`unexpected argument ${a}\n${WAIT_USAGE}`);
    } else {
      id = a;
    }
  }
  if (id === undefined) throw new UsageError(`run_id is required\n${WAIT_USAGE}`);
  if (!RUN_ID.test(id)) throw new UsageError(`invalid run_id\n${WAIT_USAGE}`);
  return { id, ...opt, pollMs: Math.max(opt.pollMs, 10) };
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** meta.json as plain JSON: the waiter must work on a run whose meta fails the strict schema. */
function readRawMeta(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runDir(id), 'meta.json'), 'utf8')) as Record<string, unknown>;
}

function asRunMeta(raw: Record<string, unknown>): RunMeta {
  const pid = raw.pid;
  const start = raw.pid_start_time;
  const meta: Record<string, unknown> = { ...raw };
  if (!(typeof pid === 'number' && Number.isInteger(pid) && pid > 0)) delete meta.pid;
  if (typeof start !== 'string') delete meta.pid_start_time;
  if (typeof raw.created_at !== 'string') meta.created_at = '';
  return meta as unknown as RunMeta;
}

/** Ends a dead run as failed_no_report; falls back to editing the raw JSON when the strict path cannot read it. */
function endDeadRun(id: string, raw: Record<string, unknown>): string {
  try {
    return reconcile(asRunMeta(raw)).status;
  } catch {
    // meta.json is not schema-valid or the run directory is read-only: still report the status
  }
  try {
    const current = readRawMeta(id);
    if (typeof current.status === 'string' && current.status !== 'running') return current.status;
    if (!existsSync(join(runDir(id), 'result.md'))) writeResult(id, NO_RESULT_TEXT);
    current.status = 'failed_no_report';
    current.exit_code = null;
    current.finished_at =
      typeof current.finished_at === 'string' ? current.finished_at : new Date().toISOString();
    writeAtomic(join(runDir(id), 'meta.json'), `${JSON.stringify(current, null, 2)}\n`);
  } catch {
    // the run directory may be gone or read-only
  }
  return 'failed_no_report';
}

/** reconcile sends SIGTERM and arms an unref'd SIGKILL timer; keep the process alive until the group is gone. */
async function drainOrphanedGroup(pid: unknown): Promise<void> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return;
  const end = Date.now() + ORPHAN_DRAIN_MS;
  while (Date.now() < end && groupMembers(pid).length > 0) await sleep(100);
}

function finish(id: string, status: string): number {
  process.stdout.write(`WINGMAN_RUN ${id} ${status}\n`);
  return status === 'done' || status === 'partial' ? 0 : 1;
}

async function waitCommand(args: string[]): Promise<number> {
  const { id, timeoutMs, pollMs, graceMs } = parseWait(args);
  const start = Date.now();
  let deadSince = 0;
  let unreadable = 0;
  for (;;) {
    let raw: Record<string, unknown> | undefined;
    try {
      raw = readRawMeta(id);
      unreadable = 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        throw new UsageError(`unknown run ${id}`);
      // meta.json may be mid-write; tolerate a few torn reads
      if (++unreadable > 5) throw new UsageError(`unreadable meta for run ${id}`);
    }
    if (raw) {
      const status = typeof raw.status === 'string' ? raw.status : '';
      if ((TERMINAL_STATUSES as string[]).includes(status)) return finish(id, status);
      if (status !== 'running') throw new UsageError(`unreadable meta for run ${id}`);
      if (supervisorGone(asRunMeta(raw))) {
        deadSince ||= Date.now();
        if (Date.now() - deadSince >= graceMs) {
          const ended = endDeadRun(id, raw);
          await drainOrphanedGroup(raw.pid);
          return finish(id, ended);
        }
      } else {
        deadSince = 0;
      }
    }
    if (timeoutMs > 0 && Date.now() - start >= timeoutMs) return 3;
    await sleep(pollMs);
  }
}

async function gcCommand(args: string[]): Promise<number> {
  let olderThanDays = DEFAULT_OLDER_THAN_DAYS;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--older-than-days') olderThanDays = numberOption(a, args[++i]);
    else throw new UsageError(`unexpected argument ${a}\n${GC_USAGE}`);
  }
  const r = await runGc({ olderThanDays, dryRun });
  const kept =
    r.runsUnreadable > 0
      ? `${r.runsKept} (${r.runsUnreadable} without a valid meta.json)`
      : `${r.runsKept}`;
  process.stdout.write(
    dryRun
      ? `wingman gc (dry run): would remove ${r.runsRemoved} runs, keep ${kept}, prune ${r.worktreesPruned} worktrees, remove ${r.locksRemoved} locks\n`
      : `wingman gc: removed ${r.runsRemoved} runs, kept ${kept}, pruned ${r.worktreesPruned} worktrees, removed ${r.locksRemoved} locks\n`,
  );
  return 0;
}
