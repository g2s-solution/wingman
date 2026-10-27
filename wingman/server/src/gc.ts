import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runDir, runsDir } from './paths.js';
import { isSameProcess } from './proc.js';
import { reconcile } from './reconcile.js';
import { listRuns } from './runs.js';
import { TERMINAL_STATUSES } from './types.js';
import { locksDir, peekReconciled, pruneOrphans, readLock } from './worktree.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A lock file that does not parse may be one still being written; only an old one is junk. */
const UNPARSABLE_LOCK_MIN_AGE_MS = 60 * 60 * 1000;

export const DEFAULT_OLDER_THAN_DAYS = 30;

export interface GcOptions {
  olderThanDays?: number;
  dryRun?: boolean;
}

export interface GcResult {
  runsRemoved: number;
  runsKept: number;
  /** Run directories without a valid meta.json; left alone and included in `runsKept`. */
  runsUnreadable: number;
  worktreesPruned: number;
  locksRemoved: number;
}

/**
 * Retention: removes run directories of terminal runs finished more than N days ago, prunes orphan
 * worktrees and removes stale lock files. Never touches a run that is not terminal and never deletes
 * a git branch. With `dryRun` it reports what it would do and changes nothing.
 */
export async function runGc(opts: GcOptions = {}): Promise<GcResult> {
  const dryRun = opts.dryRun ?? false;
  const maxAgeMs = (opts.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS) * DAY_MS;
  const now = Date.now();

  const pruned = await pruneOrphans({ minAgeMs: DAY_MS, dryRun });
  const runs = listRuns();
  const prunedWorktrees = new Set<string>();
  for (const m of runs) {
    if (pruned.includes(m.id) && m.worktree) prunedWorktrees.add(m.worktree);
  }

  const removedIds = new Set<string>();
  let runsKept = 0;
  for (const listed of runs) {
    const meta = dryRun ? peekReconciled(listed) : reconcile(listed);
    const finished = meta.finished_at ? Date.parse(meta.finished_at) : NaN;
    const old = Number.isFinite(finished) && now - finished > maxAgeMs;
    // a worktree that survived pruning (dirty, in use) is only findable through its run's meta
    const worktreeLeft =
      meta.worktree !== undefined &&
      existsSync(meta.worktree) &&
      !prunedWorktrees.has(meta.worktree);
    if (!TERMINAL_STATUSES.includes(meta.status) || !old || worktreeLeft) {
      runsKept++;
      continue;
    }
    if (!dryRun) rmSync(runDir(meta.id), { recursive: true, force: true });
    removedIds.add(meta.id);
  }

  let runsUnreadable = 0;
  if (existsSync(runsDir())) {
    const valid = new Set(runs.map((m) => m.id));
    for (const entry of readdirSync(runsDir(), { withFileTypes: true })) {
      if (entry.isDirectory() && RUN_ID.test(entry.name) && !valid.has(entry.name)) {
        runsUnreadable++;
      }
    }
  }

  return {
    runsRemoved: removedIds.size,
    runsKept: runsKept + runsUnreadable,
    runsUnreadable,
    worktreesPruned: pruned.length,
    locksRemoved: removeStaleLocks(dryRun, removedIds),
  };
}

function runExists(runId: string, removedRuns: Set<string>): boolean {
  return RUN_ID.test(runId) && !removedRuns.has(runId) && existsSync(runDir(runId));
}

function removeStaleLocks(dryRun: boolean, removedRuns: Set<string>): number {
  if (!existsSync(locksDir())) return 0;
  let removed = 0;
  for (const entry of readdirSync(locksDir())) {
    if (!entry.endsWith('.lock')) continue;
    const path = join(locksDir(), entry);
    const held = readLock(path);
    let stale: boolean;
    if (held) {
      stale = !runExists(held.run_id, removedRuns) || !isSameProcess(held.pid, held.start_time);
    } else {
      try {
        stale = Date.now() - statSync(path).mtimeMs > UNPARSABLE_LOCK_MIN_AGE_MS;
      } catch {
        continue;
      }
    }
    if (!stale) continue;
    if (!dryRun) rmSync(path, { force: true });
    removed++;
  }
  return removed;
}
