import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRows, accountsCommand, parseUntil, publicAccounts } from '../src/accounts.js';
import { maybeRunCli } from '../src/cli.js';
import { runChecks } from '../src/doctor.js';
import {
  clearLimited,
  effectiveStatus,
  isActive,
  isLimited,
  loadAccounts,
  markLimited,
  recordRateLimit,
  saveAccounts,
} from '../src/registry.js';
import { startRun, waitForRun } from '../src/runner.js';
import { createRun, readMeta, runCountsByAccount, updateStatus } from '../src/runs.js';
import { createHandlers } from '../src/tools.js';
import type { Account, RunMeta } from '../src/types.js';
import { bundleSupervisor, makeLauncher, tmp } from './helpers.js';

const T0 = new Date('2026-11-01T00:00:00Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);
const HOUR = 3600_000;

let home: string;
let callerDir: string;
let saved: Record<string, string | undefined>;
let out: string[];
let err: string[];

beforeEach(() => {
  home = tmp('limits');
  callerDir = join(home, 'caller-profile');
  mkdirSync(callerDir);
  saved = {
    WINGMAN_HOME: process.env.WINGMAN_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.WINGMAN_HOME = join(home, 'state');
  process.env.CLAUDE_CONFIG_DIR = callerDir;
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const stdout = () => out.join('');
const stderr = () => err.join('');
const registryFile = () => join(home, 'state', 'accounts.json');
const rawRegistry = () =>
  JSON.parse(readFileSync(registryFile(), 'utf8')) as { accounts: Record<string, unknown>[] };

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

const withCaller = (...accounts: Account[]): Promise<void> =>
  saveAccounts({ accounts: [...accounts, account('self', { config_dir: callerDir })] });

describe('limit state on read', () => {
  it('is limited strictly before limited_until and active from that instant on', () => {
    const a = account('a', { status: 'rate_limited', limited_until: T0.toISOString() });
    expect(isLimited(a, at(-1))).toBe(true);
    expect(effectiveStatus(a, at(-1))).toBe('rate_limited');
    expect(isActive(a, at(-1))).toBe(false);
    expect(isLimited(a, T0)).toBe(false);
    expect(effectiveStatus(a, T0)).toBe('active');
    expect(isActive(a, at(1))).toBe(true);
  });

  it('a rate_limited entry without an end stays limited; an unparsable end does not lock', () => {
    expect(isLimited(account('a', { status: 'rate_limited' }), at(10 * 365 * 24 * HOUR))).toBe(
      true,
    );
    const bad = account('b', { status: 'rate_limited', limited_until: 'not a date' });
    expect(isLimited(bad, T0)).toBe(false);
    expect(effectiveStatus(bad, T0)).toBe('active');
  });

  it('other statuses are unaffected by limited_until', () => {
    const disabled = account('d', { status: 'disabled', limited_until: at(HOUR).toISOString() });
    expect(isLimited(disabled, T0)).toBe(false);
    expect(effectiveStatus(disabled, T0)).toBe('disabled');
    expect(isActive(disabled, T0)).toBe(false);
    expect(isActive(account('x', { status: 'weird' }), T0)).toBe(false);
    expect(isActive(account('y'), T0)).toBe(true);
    expect(isActive(account('z', { status: 'active' }), T0)).toBe(true);
  });
});

describe('registry file compatibility', () => {
  it('loads entries written before limited_until existed and round-trips new ones', async () => {
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(
      registryFile(),
      JSON.stringify({
        accounts: [
          { id: 'old', label: 'old', config_dir: '/x', provider: 'claude', command: 'claude' },
          { id: 'off', label: 'off', config_dir: '/y', status: 'disabled' },
        ],
      }),
    );
    const { accounts } = await loadAccounts();
    expect(accounts.map((a) => [a.id, isActive(a, T0)])).toEqual([
      ['old', true],
      ['off', false],
    ]);
    expect(accounts[0]).not.toHaveProperty('limited_until');

    await markLimited('old', at(HOUR));
    const after = rawRegistry().accounts;
    expect(after[0]).toMatchObject({
      status: 'rate_limited',
      limited_until: at(HOUR).toISOString(),
    });
    expect(after[1]).toEqual({
      id: 'off',
      label: 'off',
      config_dir: '/y',
      provider: 'claude',
      command: 'claude',
      status: 'disabled',
    });
    expect((await loadAccounts()).accounts[0]?.limited_until).toBe(at(HOUR).toISOString());
  });

  it('markLimited refuses a disabled account and an unknown one', async () => {
    await saveAccounts({ accounts: [account('off', { status: 'disabled' })] });
    await expect(markLimited('off', at(HOUR))).rejects.toThrow(/disabled/);
    await expect(markLimited('nope', at(HOUR))).rejects.toThrow(/Unknown account "nope"/);
    await expect(clearLimited('nope')).rejects.toThrow(/Unknown account/);
  });

  it('clearLimited removes both fields and reports whether it changed anything', async () => {
    await saveAccounts({ accounts: [account('a'), account('d', { status: 'disabled' })] });
    expect(await clearLimited('a')).toBe(false);
    expect(await clearLimited('d')).toBe(false);
    await markLimited('a', at(HOUR));
    expect(await clearLimited('a')).toBe(true);
    const a = rawRegistry().accounts[0]!;
    expect(a).not.toHaveProperty('status');
    expect(a).not.toHaveProperty('limited_until');
    expect(rawRegistry().accounts[1]).toMatchObject({ status: 'disabled' });
  });

  it('recordRateLimit converts resetsAt seconds and ignores unusable data', async () => {
    await saveAccounts({ accounts: [account('a'), account('d', { status: 'disabled' })] });
    const resets = Math.floor(at(HOUR).getTime() / 1000);
    expect(await recordRateLimit('a', undefined, T0)).toBe(false);
    expect(await recordRateLimit('a', {}, T0)).toBe(false);
    expect(await recordRateLimit('a', { resetsAt: resets }, at(2 * HOUR))).toBe(false);
    expect(await recordRateLimit('a', { resetsAt: resets }, at(HOUR))).toBe(false);
    expect(await recordRateLimit('d', { resetsAt: resets }, T0)).toBe(false);
    expect(await recordRateLimit('missing', { resetsAt: resets }, T0)).toBe(false);
    expect(rawRegistry().accounts[0]).not.toHaveProperty('limited_until');
    expect(await recordRateLimit('a', { resetsAt: resets }, T0)).toBe(true);
    expect(rawRegistry().accounts[0]).toMatchObject({
      status: 'rate_limited',
      limited_until: at(HOUR).toISOString(),
    });
  });
});

describe('parseUntil', () => {
  it('accepts epoch seconds, ISO with Z or an offset, and a bare date as UTC', () => {
    expect(parseUntil('1793491260', T0).toISOString()).toBe('2026-11-01T00:01:00.000Z');
    expect(parseUntil('2026-11-01T08:00:00Z', T0).toISOString()).toBe('2026-11-01T08:00:00.000Z');
    expect(parseUntil('2026-11-01T08:00Z', T0).toISOString()).toBe('2026-11-01T08:00:00.000Z');
    expect(parseUntil('2026-11-01T08:00:00+07:00', T0).toISOString()).toBe(
      '2026-11-01T01:00:00.000Z',
    );
    expect(parseUntil('2026-11-01T08:00:00.250Z', T0).getTime()).toBe(
      Date.parse('2026-11-01T08:00:00.250Z'),
    );
    expect(parseUntil('2026-11-02', T0).toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it.each([
    '',
    'tomorrow',
    '5',
    'soon',
    '2026-13-01',
    '2026-02-31',
    '2026-11-01T25:00:00Z',
    '2026-11-01T08:61:00Z',
    '2026-11-01T08:00:00',
    '2026-11-01 08:00:00Z',
    '12345678901234',
    '-100',
    '1.5',
  ])('rejects %j', (raw) => {
    expect(() => parseUntil(raw, T0)).toThrow(/--until/);
  });

  it('rejects a time that is not in the future', () => {
    expect(() => parseUntil('2026-11-01T00:00:00Z', T0)).toThrow(/not in the future/);
    expect(() => parseUntil('2026-10-31', T0)).toThrow(/not in the future/);
    expect(() => parseUntil('1', T0)).toThrow(/not in the future/);
  });

  it('rejects a millisecond timestamp passed as epoch seconds', () => {
    expect(() => parseUntil('1793491260000', T0)).toThrow(/milliseconds?/);
    expect(parseUntil('4102444800', T0).toISOString()).toBe('2100-01-01T00:00:00.000Z');
    expect(() => parseUntil('4102444801', T0)).toThrow(/milliseconds?/);
  });
});

describe('registry write-back keeps unknown keys', () => {
  it('survives markLimited and clearLimited', async () => {
    await withCaller(account('a'));
    const raw = rawRegistry();
    raw.accounts[0]!.future_field = { keep: 'me' };
    writeFileSync(registryFile(), JSON.stringify(raw));
    await markLimited('a', new Date(Date.now() + HOUR));
    expect(rawRegistry().accounts[0]).toMatchObject({ future_field: { keep: 'me' } });
    await clearLimited('a');
    expect(rawRegistry().accounts[0]).toMatchObject({ future_field: { keep: 'me' } });
  });
});

describe('wingman accounts mark-limited / clear-limited / list', () => {
  const cli = (...args: string[]) => accountsCommand(args, () => T0);

  it('marks, lists the limit with its end time, then clears it', async () => {
    await withCaller(account('a'), account('b'));
    expect(await cli('mark-limited', 'a', '--until', '2026-11-01T05:00:00Z')).toBe(0);
    expect(stdout()).toBe('marked a limited until 2026-11-01T05:00:00.000Z\n');
    out.length = 0;

    expect(await cli('list')).toBe(0);
    const lines = stdout().split('\n');
    expect(lines[0]).toMatch(/STATUS +LIMITED_UNTIL +RUNS/);
    expect(lines.find((l) => l.startsWith('a '))).toMatch(
      /rate_limited +2026-11-01T05:00:00\.000Z/,
    );
    expect(lines.find((l) => l.startsWith('b '))).toMatch(/active +-/);
    out.length = 0;

    expect(await cli('list', '--json')).toBe(0);
    const rows = JSON.parse(stdout()) as { id: string; status: string; limited_until?: string }[];
    expect(rows.find((r) => r.id === 'a')).toMatchObject({
      status: 'rate_limited',
      limited_until: '2026-11-01T05:00:00.000Z',
    });
    expect(rows.find((r) => r.id === 'b')).not.toHaveProperty('limited_until');
    out.length = 0;

    expect(await cli('clear-limited', 'a')).toBe(0);
    expect(stdout()).toBe('cleared the limit on a\n');
    expect(await cli('clear-limited', 'a')).toBe(0);
    expect(stdout()).toMatch(/a is not marked limited/);
    expect(rawRegistry().accounts[0]).not.toHaveProperty('status');
  });

  it('list shows an expired limit as active and hides limited_until', async () => {
    await withCaller(account('a', { status: 'rate_limited', limited_until: at(-1).toISOString() }));
    expect(await cli('list', '--json')).toBe(0);
    const rows = JSON.parse(stdout()) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ id: 'a', status: 'active' });
    expect(rows[0]).not.toHaveProperty('limited_until');
    expect(rawRegistry().accounts[0]).toMatchObject({ status: 'rate_limited' });
  });

  it('accepts epoch seconds for --until', async () => {
    await withCaller(account('a'));
    expect(await cli('mark-limited', 'a', '--until', String(T0.getTime() / 1000 + 60))).toBe(0);
    expect(rawRegistry().accounts[0]).toMatchObject({ limited_until: at(60_000).toISOString() });
  });

  it('exits 2 with a clear message on bad input and writes nothing', async () => {
    await withCaller(account('a'), account('off', { status: 'disabled' }));
    const before = readFileSync(registryFile(), 'utf8');
    const cases: [string[], RegExp][] = [
      [['mark-limited', 'a'], /--until is required/],
      [['mark-limited', 'a', '--until'], /--until needs a value/],
      [['mark-limited', 'a', '--until', 'tomorrow'], /--until must be an ISO time/],
      [['mark-limited', 'a', '--until', '2026-10-01'], /not in the future/],
      [['mark-limited', '--until', '2026-12-01'], /needs exactly one account id/],
      [['mark-limited', 'a', 'b', '--until', '2026-12-01'], /needs exactly one account id/],
      [['mark-limited', 'ghost', '--until', '2026-12-01'], /unknown account "ghost"/],
      [['mark-limited', 'off', '--until', '2026-12-01'], /disabled/],
      [['mark-limited', 'a', '--until', '2026-12-01', '--bogus'], /unexpected argument --bogus/],
      [['clear-limited'], /needs exactly one account id/],
      [['clear-limited', 'ghost'], /unknown account "ghost"/],
      [['clear-limited', 'a', '--until', '2026-12-01'], /unexpected argument --until/],
    ];
    for (const [args, message] of cases) {
      err.length = 0;
      expect(await cli(...args), args.join(' ')).toBe(2);
      expect(stderr()).toMatch(message);
    }
    expect(readFileSync(registryFile(), 'utf8')).toBe(before);
  });

  it('is reachable through the main CLI entry with an injected clock', async () => {
    await withCaller(account('a'));
    const code = await maybeRunCli(
      ['node', 'index.js', 'accounts', 'mark-limited', 'a', '--until', '2026-11-01T05:00:00Z'],
      undefined,
      () => T0,
    );
    expect(code).toBe(0);
    expect(rawRegistry().accounts[0]).toMatchObject({ status: 'rate_limited' });
  });

  it('enable and disable drop limited_until', async () => {
    await withCaller(account('a'), account('b'));
    await markLimited('a', at(HOUR));
    await markLimited('b', at(HOUR));
    expect(await cli('enable', 'a')).toBe(0);
    expect(await cli('disable', 'b')).toBe(0);
    const [a, b] = rawRegistry().accounts;
    expect(a).not.toHaveProperty('status');
    expect(a).not.toHaveProperty('limited_until');
    expect(b).toMatchObject({ status: 'disabled' });
    expect(b).not.toHaveProperty('limited_until');
  });
});

describe('per-account run summary', () => {
  function run(accountId: string, status: RunMeta['status']): void {
    const meta = createRun({
      account: accountId,
      cwd: home,
      session_id: 's',
      depth: 1,
      prompt_chars: 1,
    });
    if (status !== 'running') updateStatus(meta.id, status);
  }

  it('counts finished runs per account and status, ignoring running ones', () => {
    run('a', 'done');
    run('a', 'done');
    run('a', 'rate_limited');
    run('a', 'running');
    run('b', 'failed');
    expect(runCountsByAccount()).toEqual({
      a: { total: 3, by_status: { done: 2, rate_limited: 1 } },
      b: { total: 1, by_status: { failed: 1 } },
    });
  });

  it('shows up in rows, the public view and the list table', async () => {
    run('a', 'done');
    run('a', 'cancelled');
    await withCaller(account('a'), account('b'));
    const { accounts } = await loadAccounts();
    const rows = accountRows(accounts, callerDir, T0);
    expect(rows.find((r) => r.id === 'a')?.runs).toEqual({
      total: 2,
      by_status: { done: 1, cancelled: 1 },
    });
    expect(rows.find((r) => r.id === 'b')?.runs).toEqual({ total: 0, by_status: {} });
    const pub = publicAccounts(accounts, callerDir, T0);
    expect(pub[0]).toHaveProperty('runs');
    expect(pub[0]).not.toHaveProperty('command');
    expect(pub[0]).not.toHaveProperty('config_dir');

    expect(await accountsCommand(['list'], () => T0)).toBe(0);
    expect(
      stdout()
        .split('\n')
        .find((l) => l.startsWith('a ')),
    ).toMatch(/cancelled=1 done=1/);
  });
});

describe('selection and refusal in the server handlers', () => {
  const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, CLAUDE_CONFIG_DIR: callerDir });
  const handlers = (now: Date) => createHandlers({ env: env(), now: () => now, random: () => 0 });
  const until = at(HOUR).toISOString();
  const limited = (id: string) => account(id, { status: 'rate_limited', limited_until: until });

  it('an explicit limited account is refused, naming limited_until and the alternatives', async () => {
    await withCaller(limited('a'), account('b'), account('c', { status: 'disabled' }));
    await expect(handlers(T0).start({ account: 'a', prompt: 'x', cwd: home })).rejects.toThrow(
      new RegExp(`rate limited \\(limited_until ${until}\\).*other active accounts: b \\(`),
    );
  });

  it('the refusal lists no alternatives when none are usable', async () => {
    await withCaller(limited('a'), account('c', { status: 'disabled' }));
    const error = await handlers(T0)
      .start({ account: 'a', prompt: 'x', cwd: home })
      .catch((e: Error) => e.message);
    expect(error).toMatch(/rate limited/);
    expect(error).not.toMatch(/other active accounts/);
  });

  it('a limited account without an end time is refused too', async () => {
    await withCaller(account('a', { status: 'rate_limited' }));
    await expect(handlers(T0).start({ account: 'a', prompt: 'x', cwd: home })).rejects.toThrow(
      /no end time/,
    );
  });

  it('random selection never picks a limited account and says why when none is left', async () => {
    await withCaller(limited('a'), limited('b'));
    const error = await handlers(T0)
      .start({ prompt: 'x', cwd: home })
      .catch((e: Error) => e.message);
    expect(error).toMatch(/No other active account/);
    expect(error).toContain(`a (limited_until ${until})`);
    expect(error).toContain(`b (limited_until ${until})`);
  });

  it('a limit that has expired no longer blocks selection or an explicit choice', async () => {
    await withCaller(limited('a'));
    // past selection the next error is the cwd check, so the account was accepted
    const bad = { prompt: 'x', cwd: 'relative' };
    await expect(handlers(at(HOUR - 1)).start({ account: 'a', ...bad })).rejects.toThrow(
      /rate limited/,
    );
    await expect(handlers(at(HOUR)).start({ account: 'a', ...bad })).rejects.toThrow(
      /cwd must be an absolute path/,
    );
    await expect(handlers(at(HOUR)).start(bad)).rejects.toThrow(/cwd must be an absolute path/);
    await expect(handlers(at(HOUR - 1)).start(bad)).rejects.toThrow(/No other active account/);
  });

  it('wingman_accounts reports the limited state and run counts without mutating anything', async () => {
    await withCaller(limited('a'), account('b'));
    const before = readFileSync(registryFile(), 'utf8');
    const early = (await handlers(T0).accounts()).accounts as Record<string, unknown>[];
    expect(early.find((r) => r.id === 'a')).toMatchObject({
      status: 'rate_limited',
      limited_until: until,
      runs: { total: 0, by_status: {} },
    });
    const late = (await handlers(at(HOUR)).accounts()).accounts as Record<string, unknown>[];
    expect(late.find((r) => r.id === 'a')).toMatchObject({ status: 'active' });
    expect(late.find((r) => r.id === 'a')).not.toHaveProperty('limited_until');
    expect(readFileSync(registryFile(), 'utf8')).toBe(before);
  });
});

describe('doctor', () => {
  it('reports a limited account as a warning and does not fail', async () => {
    mkdirSync(join(home, 'state'), { recursive: true });
    mkdirSync(join(home, 'profile-a'));
    await withCaller(
      account('a', {
        status: 'rate_limited',
        limited_until: at(HOUR).toISOString(),
        command: process.execPath,
      }),
    );
    const deps = {
      env: { ...process.env, WINGMAN_HOME: join(home, 'state'), CLAUDE_CONFIG_DIR: callerDir },
      homeDir: home,
      exec: () => Promise.reject(new Error('offline')),
    };
    const results = await runChecks(false, { ...deps, now: () => T0 });
    const status = results.find((r) => r.id === 'account.a.status');
    expect(status?.level).toBe('warn');
    expect(status?.message).toContain(`until ${at(HOUR).toISOString()}`);
    expect(results.some((r) => r.level === 'fail')).toBe(false);

    const expired = await runChecks(false, { ...deps, now: () => at(HOUR) });
    expect(expired.find((r) => r.id === 'account.a.status')).toMatchObject({
      level: 'ok',
      message: 'a: status active',
    });
  });
});

describe('a run that ends rate_limited marks its account', () => {
  let work: string;
  let entry: string;
  beforeAll(async () => {
    work = tmp('limits-bundle');
    entry = await bundleSupervisor(work);
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('writes status and limited_until, hints at the other accounts and refuses a retry', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
    const launcher = makeLauncher(
      work,
      'rate_limit',
      join(work, 'log.jsonl'),
      `export FAKE_CLAUDE_RESETS_AT=${resetsAt}`,
    );
    await withCaller(account('a', { command: launcher }), account('b'));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: callerDir };
    const h = createHandlers({ env, supervisorEntry: entry, random: () => 0 });

    const started = await h.start({ account: 'a', prompt: 'task', cwd: tmp('cwd') });
    // read the run first, the registry second: once a caller can see rate_limited, the account must already be limited
    let seenLimitedRun = false;
    for (let i = 0; i < 2000 && !seenLimitedRun; i++) {
      seenLimitedRun = readMeta(started.run_id as string).status === 'rate_limited';
      const acct = (await loadAccounts()).accounts.find((x) => x.id === 'a')!;
      if (seenLimitedRun) expect(acct.status).toBe('rate_limited');
      else await new Promise((r) => setTimeout(r, 5));
    }
    expect(seenLimitedRun).toBe(true);
    const finished = await waitForRun(started.run_id as string, { timeoutMs: 20000, pollMs: 50 });
    expect(finished.status).toBe('rate_limited');

    const a = (await loadAccounts()).accounts.find((x) => x.id === 'a')!;
    expect(a).toMatchObject({
      status: 'rate_limited',
      limited_until: new Date(resetsAt * 1000).toISOString(),
    });

    const result = await h.result({ run_id: started.run_id as string });
    expect(result).toMatchObject({ status: 'rate_limited', other_active_accounts: ['b'] });
    expect(result.hint).toMatch(/Other active accounts: b/);
    expect(await h.status({ run_id: started.run_id as string })).toMatchObject({
      other_active_accounts: ['b'],
    });

    await expect(h.start({ account: 'a', prompt: 'again', cwd: tmp('cwd') })).rejects.toThrow(
      /limited_until/,
    );
  });

  it('adds no hint when no other account is usable and none for other statuses', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const limitedLauncher = makeLauncher(
      work,
      'rate_limit',
      join(work, 'log2.jsonl'),
      `export FAKE_CLAUDE_RESETS_AT=${resetsAt}`,
    );
    const okLauncher = makeLauncher(work, 'ok', join(work, 'log3.jsonl'));
    await withCaller(
      account('a', { command: limitedLauncher }),
      account('b', { command: okLauncher }),
    );
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: callerDir };
    const h = createHandlers({ env, supervisorEntry: entry });

    const okRun = await h.start({ account: 'b', prompt: 'task', cwd: tmp('cwd') });
    await waitForRun(okRun.run_id as string, { timeoutMs: 20000, pollMs: 50 });
    expect(await h.result({ run_id: okRun.run_id as string })).not.toHaveProperty('hint');

    await markLimited('b', new Date(Date.now() + HOUR));
    const limitedRun = await h.start({ account: 'a', prompt: 'task', cwd: tmp('cwd') });
    await waitForRun(limitedRun.run_id as string, { timeoutMs: 20000, pollMs: 50 });
    const result = await h.result({ run_id: limitedRun.run_id as string });
    expect(result).toMatchObject({ status: 'rate_limited' });
    expect(result).not.toHaveProperty('other_active_accounts');
    expect(result).not.toHaveProperty('hint');
  });

  it('does not mark an account whose limit has no usable reset time', async () => {
    const launcher = makeLauncher(
      work,
      'rate_limit',
      join(work, 'log4.jsonl'),
      'export FAKE_CLAUDE_RESETS_AT=1000',
    );
    await withCaller(account('a', { command: launcher }));
    const meta = await startRun({
      account: { ...account('a', { command: launcher }) },
      prompt: 'task',
      cwd: tmp('cwd'),
      parentEnv: { PATH: process.env.PATH },
      supervisorEntry: entry,
    });
    const done = await waitForRun(meta.id, { timeoutMs: 20000, pollMs: 50 });
    expect(done.status).toBe('rate_limited');
    expect((await loadAccounts()).accounts[0]).not.toHaveProperty('limited_until');
  });
});
