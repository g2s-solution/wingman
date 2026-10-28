import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { maskSecrets, safeSummary } from './mask.js';
import { runDir, runsDir } from './paths.js';
import { TERMINAL_STATUSES, type RateLimitInfo, type RunMeta, type RunStatus } from './types.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const statusSchema = z.enum([
  'running',
  'done',
  'partial',
  'blocked',
  'needs_input',
  'needs_caller',
  'failed',
  'failed_no_report',
  'rate_limited',
  'cancelled',
]);

const metaSchema = z.object({
  id: z.string(),
  account: z.string(),
  cwd: z.string(),
  branch: z.string().optional(),
  run_branch: z.string().optional(),
  worktree: z.string().optional(),
  ref_snapshot: z
    .object({
      refs: z.array(z.string()),
      refs_hash: z.string(),
      config_hash: z.string(),
      hooks_hash: z.string().optional(),
    })
    .optional(),
  repo: z.string().optional(),
  run_cwd: z.string().optional(),
  session_id: z.string(),
  status: statusSchema,
  created_at: z.string(),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  pid: z.number().optional(),
  pid_start_time: z.string().optional(),
  exit_code: z.number().nullable().optional(),
  permission_denials: z.array(z.string()),
  rate_limit: z
    .object({
      status: z.string().optional(),
      resetsAt: z.number().optional(),
      rateLimitType: z.string().optional(),
      utilization: z.number().optional(),
    })
    .optional(),
  depth: z.number(),
  lock_key: z.string().optional(),
  preset: z.string().optional(),
  prompt_chars: z.number(),
}) satisfies z.ZodType<RunMeta>;

export type NewRunMeta = Omit<RunMeta, 'id' | 'status' | 'created_at' | 'permission_denials'>;

export interface RunSummary {
  id: string;
  account: string;
  status: RunStatus;
  branch?: string;
  run_branch?: string;
  created_at: string;
  finished_at?: string;
  permission_denials: string[];
  rate_limit?: RateLimitInfo;
  /** One page of the masked report, or null when the run wrote none. */
  result: string | null;
  /** Length of the whole masked report; the offsets below count into it. */
  result_total_chars?: number;
  result_offset?: number;
  /** Absent on the last page. */
  result_next_offset?: number;
}

export const RESULT_PAGE_CHARS = 4000;
export const RESULT_PAGE_MAX_CHARS = 8000;

export interface ResultPage {
  offset?: number;
  limit?: number;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function newRunId(): string {
  return randomBytes(6).toString('hex');
}

function dirOf(id: string): string {
  if (!RUN_ID.test(id)) throw new Error(`invalid run id: ${id}`);
  return runDir(id);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  chmodSync(path, DIR_MODE);
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: FILE_MODE });
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp file may not exist
    }
    throw err;
  }
}

export function createRun(meta: NewRunMeta): RunMeta {
  const id = newRunId();
  ensureDir(runsDir());
  ensureDir(dirOf(id));
  const full: RunMeta = {
    ...meta,
    id,
    status: 'running',
    created_at: new Date().toISOString(),
    permission_denials: [],
  };
  writeMeta(full);
  return full;
}

export function writeMeta(meta: RunMeta): void {
  const parsed = metaSchema.parse(meta);
  const dir = dirOf(parsed.id);
  ensureDir(dir);
  writeAtomic(join(dir, 'meta.json'), `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Merges `patch` into the run's current meta without ever changing its status. Refuses once the
 * run is terminal (reconcile may have ended it while a start was still in progress), so a stale
 * in-memory copy can never bring a finished run back to `running`.
 */
export function patchRunning(id: string, patch: Partial<Omit<RunMeta, 'id' | 'status'>>): RunMeta {
  const current = readMeta(id);
  if (TERMINAL_STATUSES.includes(current.status)) {
    throw new Error(`run ${id} already ended as ${current.status} during start`);
  }
  const next: RunMeta = { ...current, ...patch, id, status: current.status };
  writeMeta(next);
  return next;
}

export function readMeta(id: string): RunMeta {
  return metaSchema.parse(JSON.parse(readFileSync(join(dirOf(id), 'meta.json'), 'utf8')));
}

export function updateStatus(
  id: string,
  status: RunStatus,
  patch: Partial<Omit<RunMeta, 'id' | 'status'>> = {},
): RunMeta {
  const current = readMeta(id);
  if (TERMINAL_STATUSES.includes(current.status) && current.status !== status) {
    throw new Error(`run ${id} is already ${current.status}; cannot change to ${status}`);
  }
  const next: RunMeta = { ...current, ...patch, id, status };
  if (TERMINAL_STATUSES.includes(status) && !next.finished_at) {
    next.finished_at = new Date().toISOString();
  }
  writeMeta(next);
  return next;
}

export function appendEvent(id: string, rawLine: string): void {
  const dir = dirOf(id);
  ensureDir(dir);
  const path = join(dir, 'events.jsonl');
  appendFileSync(path, rawLine.endsWith('\n') ? rawLine : `${rawLine}\n`, { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}

export function pruneEvents(id: string, maxBytes: number): void {
  const path = join(dirOf(id), 'events.jsonl');
  if (!existsSync(path)) return;
  const fd = openSync(path, 'r');
  let tail: Buffer;
  let size: number;
  try {
    size = fstatSync(fd).size;
    if (size <= maxBytes) return;
    tail = Buffer.alloc(maxBytes);
    readSync(fd, tail, 0, maxBytes, size - maxBytes);
  } finally {
    closeSync(fd);
  }
  const firstNewline = tail.indexOf(0x0a);
  const kept = firstNewline === -1 ? Buffer.alloc(0) : tail.subarray(firstNewline + 1);
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, kept, { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, path);
}

export const EVENTS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Deletes `events.jsonl` (never the run directory) of terminal runs finished more than `maxAgeMs` ago. */
export function pruneOldEvents(maxAgeMs: number = EVENTS_RETENTION_MS): string[] {
  const pruned: string[] = [];
  for (const meta of listRuns()) {
    if (!TERMINAL_STATUSES.includes(meta.status) || !meta.finished_at) continue;
    if (Date.now() - Date.parse(meta.finished_at) < maxAgeMs) continue;
    const path = join(dirOf(meta.id), 'events.jsonl');
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    pruned.push(meta.id);
  }
  return pruned;
}

export function writeResult(id: string, text: string): void {
  const dir = dirOf(id);
  ensureDir(dir);
  writeAtomic(join(dir, 'result.md'), text);
}

export function listRuns(): RunMeta[] {
  if (!existsSync(runsDir())) return [];
  const runs: RunMeta[] = [];
  for (const entry of readdirSync(runsDir())) {
    if (!RUN_ID.test(entry)) continue;
    try {
      runs.push(readMeta(entry));
    } catch {
      // skip directories without a valid meta.json
    }
  }
  return runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export interface AccountRunCounts {
  total: number;
  by_status: Record<string, number>;
}

/** Finished runs per account by terminal status, from meta.json only (never the event log). */
export function runCountsByAccount(runs: RunMeta[] = listRuns()): Record<string, AccountRunCounts> {
  const counts: Record<string, AccountRunCounts> = {};
  for (const run of runs) {
    if (!TERMINAL_STATUSES.includes(run.status)) continue;
    const entry = (counts[run.account] ??= { total: 0, by_status: {} });
    entry.total += 1;
    entry.by_status[run.status] = (entry.by_status[run.status] ?? 0) + 1;
  }
  return counts;
}

export function runSummary(id: string, page: ResultPage = {}): RunSummary {
  const meta = readMeta(id);
  const resultPath = join(dirOf(id), 'result.md');
  const masked = existsSync(resultPath) ? maskSecrets(readFileSync(resultPath, 'utf8')) : null;
  const summary: RunSummary = {
    id: meta.id,
    account: meta.account,
    status: meta.status,
    created_at: meta.created_at,
    permission_denials: meta.permission_denials.map((d) => safeSummary(d, 200)),
    result: null,
  };
  if (masked !== null) {
    // Mask the whole report first, then slice: a secret split by a page boundary would escape the mask.
    const limit = Math.min(Math.max(page.limit ?? RESULT_PAGE_CHARS, 1), RESULT_PAGE_MAX_CHARS);
    const start = Math.min(Math.max(page.offset ?? 0, 0), masked.length);
    let end = Math.min(start + limit, masked.length);
    const last = masked.charCodeAt(end - 1);
    if (end < masked.length && end > start && last >= 0xd800 && last <= 0xdbff) {
      // keep a surrogate pair whole, but always advance: a page of one unit takes the whole pair
      end = end - 1 > start ? end - 1 : end + 1;
    }
    summary.result = masked.slice(start, end);
    summary.result_total_chars = masked.length;
    summary.result_offset = start;
    if (end < masked.length) summary.result_next_offset = end;
  }
  if (meta.branch !== undefined) summary.branch = meta.branch;
  if (meta.run_branch !== undefined) summary.run_branch = meta.run_branch;
  if (meta.finished_at !== undefined) summary.finished_at = meta.finished_at;
  if (meta.rate_limit !== undefined) summary.rate_limit = meta.rate_limit;
  return summary;
}
