import { isLimited, loadAccounts, markLimited } from './registry.js';
import { listRuns } from './runs.js';
import type { RunMeta } from './types.js';

export const BREAKER_REASON = 'consecutive_failures';
export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MINUTES = 30;

const FAILURES = new Set<string>(['failed', 'failed_no_report']);
// A finished task proves the account works. Other endings (needs_input, blocked, cancelled, ...)
// say more about the task or the caller than about the account, so they neither count nor reset.
const SUCCESSES = new Set<string>(['done', 'partial']);

export interface BreakerConfig {
  threshold: number;
  cooldownMs: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  return Number(raw);
}

/** `WINGMAN_BREAKER_FAILURES=0` turns the breaker off. */
export function breakerConfig(env: NodeJS.ProcessEnv = process.env): BreakerConfig {
  return {
    threshold: positiveInt(env.WINGMAN_BREAKER_FAILURES, DEFAULT_FAILURE_THRESHOLD),
    cooldownMs:
      positiveInt(env.WINGMAN_BREAKER_COOLDOWN_MINUTES, DEFAULT_COOLDOWN_MINUTES) * 60_000,
  };
}

/** Failed runs of the account since its latest successful run, newest first, skipping neutral endings. */
export function consecutiveFailures(runs: RunMeta[], account: string): number {
  const finished = runs
    .filter((r) => r.account === account && r.finished_at !== undefined)
    .sort((a, b) => b.finished_at!.localeCompare(a.finished_at!));
  let count = 0;
  for (const run of finished) {
    if (SUCCESSES.has(run.status)) break;
    if (FAILURES.has(run.status)) count += 1;
  }
  return count;
}

/**
 * Limits the account for the cooldown once it has failed `threshold` runs in a row. Returns true
 * when it did. Leaves an account that is already limited, disabled or unknown alone. After the
 * cooldown the next failure trips it again at once, because the old failures still count.
 */
export async function tripBreaker(
  account: string,
  config: BreakerConfig = breakerConfig(),
  runs: RunMeta[] = listRuns(),
  now: Date = new Date(),
): Promise<boolean> {
  if (config.threshold === 0 || consecutiveFailures(runs, account) < config.threshold) {
    return false;
  }
  const entry = (await loadAccounts()).accounts.find((a) => a.id === account);
  if (entry === undefined || isLimited(entry, now)) return false;
  try {
    await markLimited(account, new Date(now.getTime() + config.cooldownMs), BREAKER_REASON);
  } catch {
    return false;
  }
  return true;
}
