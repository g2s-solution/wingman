import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertCanStart, callerProfile, currentDepth } from '../src/self.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wingman-self-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('callerProfile', () => {
  it('resolves symlinked config dirs to the same profile', async () => {
    const real = join(root, 'real');
    await mkdir(real);
    await symlink(real, join(root, 'link'));
    const a = callerProfile({ CLAUDE_CONFIG_DIR: real });
    expect(a).toBe(await realpath(real));
    expect(callerProfile({ CLAUDE_CONFIG_DIR: join(root, 'link') })).toBe(a);
  });

  it('falls back to path.resolve when the dir does not exist', () => {
    const missing = join(root, 'missing');
    expect(callerProfile({ CLAUDE_CONFIG_DIR: missing })).toBe(missing);
  });

  it('uses ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    const p = callerProfile({});
    expect(p.endsWith('.claude')).toBe(true);
  });
});

describe('depth guard', () => {
  it('parses WINGMAN_DEPTH, treating missing or invalid as 0', () => {
    expect(currentDepth({})).toBe(0);
    expect(currentDepth({ WINGMAN_DEPTH: 'abc' })).toBe(0);
    expect(currentDepth({ WINGMAN_DEPTH: '-1' })).toBe(0);
    expect(currentDepth({ WINGMAN_DEPTH: '2' })).toBe(2);
  });

  it('refuses a nested start and allows the first level', () => {
    expect(() => assertCanStart({})).not.toThrow();
    expect(() => assertCanStart({ WINGMAN_DEPTH: '1' })).toThrow(/WINGMAN_DEPTH/);
    expect(() => assertCanStart({ WINGMAN_DEPTH: '1' }, 2)).not.toThrow();
  });
});
