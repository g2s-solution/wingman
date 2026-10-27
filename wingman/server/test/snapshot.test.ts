import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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

  it('reports hooks when a hook is added, edited or removed, and ignores samples', async () => {
    const repo = makeRepo('main');
    const hooks = join(repo, '.git', 'hooks');
    const snap = await takeSnapshot(defaultExec, repo, 'main');
    expect(snap?.hooks_hash).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(hooks, 'pre-push.sample'), 'noise');
    expect(await changedSince(defaultExec, repo, snap!)).toEqual([]);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    expect(await changedSince(defaultExec, repo, snap!)).toEqual(['hooks']);
    const withHook = await takeSnapshot(defaultExec, repo, 'main');
    expect(await changedSince(defaultExec, repo, withHook!)).toEqual([]);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    expect(await changedSince(defaultExec, repo, withHook!)).toEqual(['hooks']);
    rmSync(join(hooks, 'pre-commit'));
    expect(await changedSince(defaultExec, repo, withHook!)).toEqual(['hooks']);
  });

  it('sees a hook added in the shared hooks directory from a linked worktree', async () => {
    const repo = makeRepo('main');
    const linked = join(tmp('linked'), 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', linked);
    const snap = await takeSnapshot(defaultExec, linked, 'main');
    writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n');
    expect(await changedSince(defaultExec, linked, snap!)).toEqual(['hooks']);
  });

  it('a snapshot without hooks_hash (older meta) never reports hooks', async () => {
    const repo = makeRepo('main');
    const snap = await takeSnapshot(defaultExec, repo, 'main');
    const old = { refs: snap!.refs, refs_hash: snap!.refs_hash, config_hash: snap!.config_hash };
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'x');
    expect(await changedSince(defaultExec, repo, old)).toEqual([]);
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
