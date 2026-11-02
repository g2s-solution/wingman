import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude.js';
import { getAdapter } from '../src/adapters/index.js';
import { guardPrompt } from '../src/guard.js';
import { mapOutcome, startRun } from '../src/runner.js';
import type { Account } from '../src/types.js';
import { tmp } from './helpers.js';

describe('adapter registry', () => {
  it('returns the claude adapter and refuses unknown providers', () => {
    expect(getAdapter('claude')).toBe(claudeAdapter);
    expect(() => getAdapter('nope')).toThrow('No adapter for provider "nope"');
    expect(() => getAdapter('constructor')).toThrow('No adapter for provider');
  });

  it('exposes rate-limit rejection through the adapter', () => {
    expect(claudeAdapter.isRateLimitRejected({ status: 'rejected' })).toBe(true);
    expect(claudeAdapter.isRateLimitRejected({ status: 'allowed' })).toBe(false);
  });
});

describe('guardPrompt by provider', () => {
  it('keeps the Claude wording by default and neutral wording for others', () => {
    expect(guardPrompt()).toContain('Claude Code session');
    expect(guardPrompt()).toContain('new-agent skill');
    const neutral = guardPrompt('codex');
    expect(neutral).not.toMatch(/Claude|new-agent/);
    expect(neutral).toContain('coding-agent session');
    expect(neutral.split('\n')).toHaveLength(guardPrompt().split('\n').length);
    expect(neutral).toContain('WINGMAN_STATUS: needs_input');
  });
});

describe('plugin-change detection only for claude', () => {
  const base = {
    finished: {
      result: 'I ran claude plugin update wingman\nWINGMAN_STATUS: done',
      is_error: false,
    },
    exitCode: 0,
    signal: null,
    timedOut: false,
    rateRejected: false,
  };
  it('applies to claude and to the default, not to other providers', () => {
    expect(mapOutcome(base).status).toBe('needs_caller');
    expect(mapOutcome({ ...base, provider: 'claude' }).status).toBe('needs_caller');
    expect(mapOutcome({ ...base, provider: 'codex' }).status).toBe('done');
  });
});

describe('startRun with another provider', () => {
  it('rejects allowed_tools, which are Claude tool rules', async () => {
    const account: Account = {
      id: 'x',
      label: 'x',
      config_dir: '/tmp/x',
      provider: 'codex',
      command: 'codex',
      status: 'active',
    } as Account;
    await expect(
      startRun({
        account,
        prompt: 'p',
        cwd: '/tmp',
        worktree: false,
        allowed_tools: ['Read'],
        adapter: {
          ...claudeAdapter,
          provider: 'codex',
          capabilities: { allowedTools: false, maxTurns: false, agentCommits: false },
        },
      }),
    ).rejects.toThrow('allowed_tools are Claude tool rules');
  });

  it('fails clearly for a provider with no adapter', async () => {
    const account = { id: 'x', config_dir: '/tmp/x', provider: 'nope', command: 'x' } as Account;
    await expect(startRun({ account, prompt: 'p', cwd: '/tmp', worktree: false })).rejects.toThrow(
      'No adapter for provider "nope"',
    );
  });
});

describe('model names in startRun', () => {
  it('rejects a flag-like model before anything starts', async () => {
    const account = { id: 'x', config_dir: '/tmp/x', provider: 'claude', command: 'x' } as Account;
    await expect(
      startRun({ account, prompt: 'p', cwd: '/tmp', worktree: false, model: '--evil' }),
    ).rejects.toThrow('not a valid model name');
  });
});

describe('a rejected model leaves nothing behind', () => {
  it('creates no run and no worktree', async () => {
    const saved = process.env.WINGMAN_HOME;
    process.env.WINGMAN_HOME = tmp('home-model');
    try {
      const { runsDir } = await import('../src/paths.js');
      const { existsSync, readdirSync } = await import('node:fs');
      const account = {
        id: 'x',
        config_dir: '/tmp/x',
        provider: 'claude',
        command: 'x',
      } as Account;
      const before = existsSync(runsDir()) ? readdirSync(runsDir()).length : 0;
      await expect(
        startRun({ account, prompt: 'p', cwd: '/tmp', worktree: false, model: '--evil' }),
      ).rejects.toThrow('not a valid model name');
      const after = existsSync(runsDir()) ? readdirSync(runsDir()).length : 0;
      expect(after).toBe(before);
    } finally {
      if (saved === undefined) delete process.env.WINGMAN_HOME;
      else process.env.WINGMAN_HOME = saved;
    }
  });
});
