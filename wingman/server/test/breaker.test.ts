import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRows } from '../src/accounts.js';
import { breakerConfig, BREAKER_REASON, consecutiveFailures, tripBreaker } from '../src/breaker.js';
import { clearLimited, loadAccounts, markLimited, saveAccounts } from '../src/registry.js';
import { waitForRun } from '../src/runner.js';
import { createHandlers } from '../src/tools.js';
import type { Account, RunMeta, RunStatus } from '../src/types.js';
import { bundleSupervisor, makeLauncher, tmp } from './helpers.js';

const T0 = new Date('2026-11-01T00:00:00Z');
const config = { threshold: 3, cooldownMs: 30 * 60_000 };

let home: string;
let callerDir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = tmp('breaker');
  callerDir = join(home, 'caller-profile');
  mkdirSync(callerDir);
  saved = {
    WINGMAN_HOME: process.env.WINGMAN_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.WINGMAN_HOME = join(home, 'state');
  process.env.CLAUDE_CONFIG_DIR = callerDir;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function account(id: string, extra: Partial<Account> = {}): Account {
  return {
    id,
    label: id,
    config_dir: join(home, `profile-${id}`),
    provider: 'claude',
    command: 'claude',
    ...extra,
  };
}

// minutes after T0 the run finished; newest has the largest value
function run(status: RunStatus, minute: number, acct = 'a'): RunMeta {
  return {
    id: `r${minute}${acct}`,
    account: acct,
    status,
    created_at: new Date(T0.getTime() + minute * 60_000).toISOString(),
    finished_at: new Date(T0.getTime() + minute * 60_000).toISOString(),
  } as RunMeta;
}

describe('consecutiveFailures', () => {
  it('counts failed and failed_no_report since the latest success, newest first', () => {
    const runs = [
      run('failed', 1),
      run('done', 2),
      run('failed', 3),
      run('failed_no_report', 4),
      run('failed', 5),
    ];
    expect(consecutiveFailures(runs, 'a')).toBe(3);
  });

  it('is reset by done or partial and ignores unfinished runs and other accounts', () => {
    expect(consecutiveFailures([run('failed', 1), run('failed', 2), run('done', 3)], 'a')).toBe(0);
    expect(consecutiveFailures([run('failed', 1), run('failed', 2), run('partial', 3)], 'a')).toBe(
      0,
    );
    const running = { ...run('running', 9), finished_at: undefined } as RunMeta;
    expect(consecutiveFailures([run('failed', 1), running], 'a')).toBe(1);
    expect(consecutiveFailures([run('failed', 1, 'b'), run('failed', 2, 'b')], 'a')).toBe(0);
  });

  it('breaks a finished_at tie by created_at, newest first', () => {
    const t = new Date(T0).toISOString();
    const done = {
      ...run('done', 5),
      finished_at: t,
      created_at: '2026-11-01T00:00:01Z',
    } as RunMeta;
    const failed = {
      ...run('failed', 5),
      finished_at: t,
      created_at: '2026-11-01T00:00:02Z',
    } as RunMeta;
    expect(consecutiveFailures([done, failed], 'a')).toBe(1);
    expect(consecutiveFailures([failed, done], 'a')).toBe(1);
  });

  it('skips needs_input, no_status, cancelled, blocked and rate_limited without counting or resetting', () => {
    const runs = [
      run('failed', 1),
      run('needs_input', 2),
      run('no_status', 2.5),
      run('cancelled', 3),
      run('failed', 4),
      run('blocked', 5),
      run('rate_limited', 6),
      run('failed', 7),
    ];
    expect(consecutiveFailures(runs, 'a')).toBe(3);
  });
});

describe('breakerConfig', () => {
  it('defaults to 3 failures and 30 minutes, reads overrides and ignores junk', () => {
    expect(breakerConfig({})).toEqual({ threshold: 3, cooldownMs: 30 * 60_000 });
    expect(
      breakerConfig({ WINGMAN_BREAKER_FAILURES: '5', WINGMAN_BREAKER_COOLDOWN_MINUTES: '10' }),
    ).toEqual({ threshold: 5, cooldownMs: 10 * 60_000 });
    expect(
      breakerConfig({ WINGMAN_BREAKER_FAILURES: 'x', WINGMAN_BREAKER_COOLDOWN_MINUTES: '-1' }),
    ).toEqual({ threshold: 3, cooldownMs: 30 * 60_000 });
    expect(breakerConfig({ WINGMAN_BREAKER_FAILURES: '0' }).threshold).toBe(0);
    expect(breakerConfig({ WINGMAN_BREAKER_COOLDOWN_MINUTES: '0' }).cooldownMs).toBe(60_000);
    expect(breakerConfig({ WINGMAN_BREAKER_COOLDOWN_MINUTES: '99999999' }).cooldownMs).toBe(
      7 * 24 * 60 * 60_000,
    );
  });
});

describe('tripBreaker', () => {
  const fails = (n: number) => Array.from({ length: n }, (_, i) => run('failed', i + 1));

  it('does nothing below the threshold and when switched off', async () => {
    await saveAccounts({ accounts: [account('a')] });
    expect(await tripBreaker('a', config, fails(2), T0)).toBe(false);
    expect(await tripBreaker('a', { ...config, threshold: 0 }, fails(9), T0)).toBe(false);
    expect((await loadAccounts()).accounts[0]!.status).toBeUndefined();
  });

  it('limits the account for the cooldown with a reason once the streak reaches the threshold', async () => {
    await saveAccounts({ accounts: [account('a')] });
    expect(await tripBreaker('a', config, fails(3), T0)).toBe(true);
    const a = (await loadAccounts()).accounts[0]!;
    expect(a).toMatchObject({
      status: 'rate_limited',
      limited_until: new Date(T0.getTime() + 30 * 60_000).toISOString(),
      limited_reason: BREAKER_REASON,
    });
    const row = accountRows([a], callerDir, T0)[0]!;
    expect(row).toMatchObject({ status: 'rate_limited', limited_reason: BREAKER_REASON });
    expect(accountRows([a], callerDir, new Date(T0.getTime() + 31 * 60_000))[0]).toMatchObject({
      status: 'active',
    });
    expect(accountRows([a], callerDir, new Date(T0.getTime() + 31 * 60_000))[0]).not.toHaveProperty(
      'limited_reason',
    );
  });

  it('trips again at once when the first run after the cooldown fails too', async () => {
    await saveAccounts({ accounts: [account('a')] });
    await tripBreaker('a', config, fails(3), T0);
    const later = new Date(T0.getTime() + 31 * 60_000);
    expect(await tripBreaker('a', config, fails(4), later)).toBe(true);
    expect((await loadAccounts()).accounts[0]!.limited_until).toBe(
      new Date(later.getTime() + 30 * 60_000).toISOString(),
    );
  });

  it('leaves a limited, disabled or unknown account alone', async () => {
    await saveAccounts({
      accounts: [account('a'), account('off', { status: 'disabled' })],
    });
    await markLimited('a', new Date(T0.getTime() + 5 * 3600_000));
    expect(await tripBreaker('a', config, fails(5), T0)).toBe(false);
    expect((await loadAccounts()).accounts[0]!).not.toHaveProperty('limited_reason');
    expect(
      await tripBreaker(
        'off',
        config,
        fails(5).map((r) => ({ ...r, account: 'off' })),
        T0,
      ),
    ).toBe(false);
    expect(
      await tripBreaker(
        'nope',
        config,
        fails(5).map((r) => ({ ...r, account: 'nope' })),
        T0,
      ),
    ).toBe(false);
    expect((await loadAccounts()).accounts[1]!.status).toBe('disabled');
  });

  it('drops the reason when a provider rate limit overwrites it and on clear-limited', async () => {
    await saveAccounts({ accounts: [account('a')] });
    await tripBreaker('a', config, fails(3), T0);
    await clearLimited('a');
    expect((await loadAccounts()).accounts[0]!).not.toHaveProperty('limited_reason');
    await tripBreaker('a', config, fails(3), T0);
    await markLimited('a', new Date(T0.getTime() + 3600_000));
    expect((await loadAccounts()).accounts[0]!).not.toHaveProperty('limited_reason');
  });
});

describe('a real account that keeps failing', () => {
  let work: string;
  let entry: string;
  beforeAll(async () => {
    work = tmp('breaker-bundle');
    entry = await bundleSupervisor(work);
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('is taken out of rotation after three failed runs and named in the refusal', async () => {
    const bad = makeLauncher(work, 'nonzero', join(work, 'log.jsonl'));
    await saveAccounts({
      accounts: [account('a', { command: bad }), account('self', { config_dir: callerDir })],
    });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: callerDir };
    const h = createHandlers({ env, supervisorEntry: entry, random: () => 0 });
    for (let i = 0; i < 3; i++) {
      const started = await h.start({ account: 'a', prompt: 'task', cwd: tmp('cwd') });
      const done = await waitForRun(started.run_id as string, { timeoutMs: 20000, pollMs: 50 });
      expect(done.status).toBe('failed');
      const limited = (await loadAccounts()).accounts[0]!.status === 'rate_limited';
      expect(limited).toBe(i === 2);
    }
    await expect(h.start({ prompt: 'task', cwd: tmp('cwd') })).rejects.toThrow(
      /No other active account.*rate limited: a .*consecutive_failures/,
    );
    await expect(h.start({ account: 'a', prompt: 'task', cwd: tmp('cwd') })).rejects.toThrow(
      /consecutive_failures/,
    );
  });
});
