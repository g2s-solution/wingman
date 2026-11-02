import { afterEach, describe, expect, it } from 'vitest';
import { isAbsolute, join, resolve } from 'node:path';
import { accountsFile, runDir, runsDir, wingmanHome, worktreesDir } from '../src/paths.js';

describe('paths', () => {
  const saved = process.env.WINGMAN_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.WINGMAN_HOME;
    else process.env.WINGMAN_HOME = saved;
  });

  it('honours WINGMAN_HOME', () => {
    process.env.WINGMAN_HOME = '/tmp/wm-test-home';
    expect(wingmanHome()).toBe('/tmp/wm-test-home');
    expect(accountsFile()).toBe(join('/tmp/wm-test-home', 'accounts.json'));
    expect(runsDir()).toBe(join('/tmp/wm-test-home', 'runs'));
    expect(runDir('abc')).toBe(join('/tmp/wm-test-home', 'runs', 'abc'));
    expect(worktreesDir()).toBe(join('/tmp/wm-test-home', 'worktrees'));
  });

  it('resolves a relative WINGMAN_HOME to an absolute path', () => {
    process.env.WINGMAN_HOME = 'relative-wm';
    expect(wingmanHome()).toBe(resolve('relative-wm'));
    expect(isAbsolute(wingmanHome())).toBe(true);
  });

  it('defaults to ~/.wingman', () => {
    delete process.env.WINGMAN_HOME;
    expect(wingmanHome().endsWith('.wingman')).toBe(true);
  });
});
