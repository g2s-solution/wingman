import { describe, expect, it } from 'vitest';
import { changedSince, takeSnapshot } from '../src/snapshot.js';
import { defaultExec } from '../src/worktree.js';
import { git, makeRepo, tmp } from './helpers.js';

describe('ref snapshot', () => {
  it('lists the base and caller branches and sees no change on a quiet repo', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/s');
    const snap = await takeSnapshot(defaultExec, repo, 'feat/s');
    expect(snap?.refs).toContain('refs/heads/feat/s');
    expect(snap?.refs).toContain('refs/heads/main');
    expect(snap?.refs).toEqual([...(snap?.refs ?? [])].sort());
    expect(snap?.refs_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await changedSince(defaultExec, repo, snap!)).toEqual([]);
  });

  it('reports refs when a watched branch moves, and not for a new branch', async () => {
    const repo = makeRepo('main');
    git(repo, 'switch', '-q', '-c', 'feat/s');
    const snap = await takeSnapshot(defaultExec, repo, 'feat/s');
    git(repo, 'branch', 'wingman/other');
    expect(await changedSince(defaultExec, repo, snap!)).toEqual([]);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'moves the caller branch');
    expect(await changedSince(defaultExec, repo, snap!)).toEqual(['refs']);
  });

  it('reports config when the local git config changes', async () => {
    const repo = makeRepo('main');
    const snap = await takeSnapshot(defaultExec, repo, 'main');
    git(repo, 'config', 'core.hooksPath', '/nonexistent');
    expect(await changedSince(defaultExec, repo, snap!)).toEqual(['config']);
  });

  it('is undefined outside a repository and reports nothing when git cannot be read', async () => {
    const dir = tmp('norepo');
    expect(await takeSnapshot(defaultExec, dir, 'main')).toBeUndefined();
    const snap = {
      refs: ['refs/heads/main'],
      refs_hash: 'a'.repeat(64),
      config_hash: 'b'.repeat(64),
    };
    expect(await changedSince(defaultExec, dir, snap)).toEqual([]);
  });
});
