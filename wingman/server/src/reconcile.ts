import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from './paths.js';
import { isSameProcess } from './proc.js';
import { readMeta, updateStatus, writeResult } from './runs.js';
import { TERMINAL_STATUSES, type RunMeta } from './types.js';

/**
 * A run is `running` before its supervisor pid is recorded: the worktree fetch, setup command
 * and spawn all happen in that window, so its budget must stay below this grace.
 */
export const DEFAULT_NO_PID_GRACE_MS = 20 * 60 * 1000;

export interface ReconcileOptions {
  noPidGraceMs?: number;
  now?: number;
}

function graceMs(opts: ReconcileOptions): number {
  if (opts.noPidGraceMs !== undefined) return opts.noPidGraceMs;
  const raw = Number(process.env.WINGMAN_NO_PID_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NO_PID_GRACE_MS;
}

/**
 * Ends a `running` run whose supervisor is gone (dead pid, pid reused by another process, or no
 * pid recorded long after creation) as `failed_no_report` and persists that. Every tool path
 * calls this so a dead run never stays `running` just because nobody was waiting on it.
 */
export function reconcile(meta: RunMeta, opts: ReconcileOptions = {}): RunMeta {
  if (meta.status !== 'running') return meta;
  if (meta.pid !== undefined) {
    if (isSameProcess(meta.pid, meta.pid_start_time)) return meta;
  } else {
    const age = (opts.now ?? Date.now()) - Date.parse(meta.created_at);
    if (!(age > graceMs(opts))) return meta;
  }
  // the supervisor may have finalized between the caller's read and the liveness check
  const again = readMeta(meta.id);
  if (TERMINAL_STATUSES.includes(again.status)) return again;
  if (!existsSync(join(runDir(meta.id), 'result.md'))) {
    writeResult(meta.id, '[wingman] the run ended without a result message (supervisor gone)');
  }
  try {
    return updateStatus(meta.id, 'failed_no_report', { exit_code: null });
  } catch {
    return readMeta(meta.id);
  }
}
