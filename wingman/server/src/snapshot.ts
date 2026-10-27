import { createHash } from 'node:crypto';
import { baseBranches, withoutProxy, type ExecFn } from './worktree.js';
import type { RefSnapshot } from './types.js';

const SNAPSHOT_TIMEOUT_MS = 30_000;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

async function git(exec: ExecFn, repo: string, args: string[]): Promise<string | undefined> {
  const res = await exec('git', args, {
    cwd: repo,
    env: withoutProxy(process.env),
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
  });
  return res.code === 0 ? res.stdout : undefined;
}

async function observe(
  exec: ExecFn,
  repo: string,
  refs: string[],
): Promise<{ refs_hash: string; config_hash: string } | undefined> {
  const listed = await git(exec, repo, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    ...refs,
  ]);
  const config = await git(exec, repo, ['config', '--local', '--list']);
  if (listed === undefined || config === undefined) return undefined;
  return { refs_hash: sha(listed), config_hash: sha(config) };
}

/**
 * Hashes the refs a run must not move (the base branches and the caller branch, never the run
 * branch) and the repository's local config, so the run's end can tell whether either changed.
 */
export async function takeSnapshot(
  exec: ExecFn,
  repo: string,
  callerBranch: string,
): Promise<RefSnapshot | undefined> {
  const names = new Set([...(await baseBranches(exec, repo, process.env)), callerBranch]);
  const refs = [...names].map((name) => `refs/heads/${name}`).sort();
  const seen = await observe(exec, repo, refs);
  return seen ? { refs, ...seen } : undefined;
}

/** What changed since the snapshot: `refs` and/or `config`. Empty when nothing changed or git is unreadable. */
export async function changedSince(
  exec: ExecFn,
  repo: string,
  snapshot: RefSnapshot,
): Promise<('refs' | 'config')[]> {
  const seen = await observe(exec, repo, snapshot.refs);
  if (!seen) return [];
  const changed: ('refs' | 'config')[] = [];
  if (seen.refs_hash !== snapshot.refs_hash) changed.push('refs');
  if (seen.config_hash !== snapshot.config_hash) changed.push('config');
  return changed;
}
