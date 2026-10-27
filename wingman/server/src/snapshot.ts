import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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

/** Names, sizes and content hashes of the hooks (not the shipped `*.sample` files), sorted by name. */
function hashHooks(hooksDir: string): string {
  if (!existsSync(hooksDir)) return sha('');
  const lines: string[] = [];
  for (const name of readdirSync(hooksDir).sort()) {
    if (name.endsWith('.sample')) continue;
    try {
      const path = join(hooksDir, name);
      if (!statSync(path).isFile()) continue;
      const content = readFileSync(path);
      lines.push(`${name} ${content.length} ${createHash('sha256').update(content).digest('hex')}`);
    } catch {
      lines.push(`${name} unreadable`);
    }
  }
  return sha(lines.join('\n'));
}

async function observe(
  exec: ExecFn,
  repo: string,
  refs: string[],
): Promise<{ refs_hash: string; config_hash: string; hooks_hash: string } | undefined> {
  const listed = await git(exec, repo, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    ...refs,
  ]);
  const config = await git(exec, repo, ['config', '--local', '--list']);
  const common = await git(exec, repo, ['rev-parse', '--git-common-dir']);
  if (listed === undefined || config === undefined || common === undefined) return undefined;
  const commonDir = common.trim();
  const hooksDir = join(isAbsolute(commonDir) ? commonDir : resolve(repo, commonDir), 'hooks');
  return { refs_hash: sha(listed), config_hash: sha(config), hooks_hash: hashHooks(hooksDir) };
}

/**
 * Hashes the refs a run must not move (the base branches and the caller branch, never the run
 * branch) and the repository's local config and hooks directory, so the run's end can tell whether either changed.
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

export type GuardrailChange = 'refs' | 'config' | 'hooks';

/**
 * What changed since the snapshot: `refs`, `config` and/or `hooks` (`core.hooksPath` is part of the
 * config). Empty when nothing changed or git is unreadable; a snapshot from before hooks were
 * tracked has no `hooks_hash` and never reports `hooks`.
 */
export async function changedSince(
  exec: ExecFn,
  repo: string,
  snapshot: RefSnapshot,
): Promise<GuardrailChange[]> {
  const seen = await observe(exec, repo, snapshot.refs);
  if (!seen) return [];
  const changed: GuardrailChange[] = [];
  if (seen.refs_hash !== snapshot.refs_hash) changed.push('refs');
  if (seen.config_hash !== snapshot.config_hash) changed.push('config');
  if (snapshot.hooks_hash !== undefined && seen.hooks_hash !== snapshot.hooks_hash) {
    changed.push('hooks');
  }
  return changed;
}
