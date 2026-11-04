import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountsFile } from '../src/paths.js';
import { callerProfile } from '../src/self.js';
import {
  getAccount,
  loadAccounts,
  pickWeighted,
  saveAccounts,
  setWeight,
  targetsFor,
  weightOf,
} from '../src/registry.js';
import type { Account } from '../src/types.js';

let root: string;
const prevHome = process.env.WINGMAN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wingman-reg-'));
  process.env.WINGMAN_HOME = join(root, 'home');
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.WINGMAN_HOME;
  else process.env.WINGMAN_HOME = prevHome;
  await rm(root, { recursive: true, force: true });
});

const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

describe('registry', () => {
  it('creates an empty registry with 0700 dir and 0600 file when missing', async () => {
    expect(await loadAccounts()).toEqual({ accounts: [] });
    expect(await mode(process.env.WINGMAN_HOME as string)).toBe(0o700);
    expect(await mode(accountsFile())).toBe(0o600);
  });

  it('fills provider and command defaults', async () => {
    await mkdir(process.env.WINGMAN_HOME as string, { recursive: true });
    await writeFile(
      accountsFile(),
      JSON.stringify({ accounts: [{ id: 'a', label: 'A', config_dir: '/x' }] }),
    );
    const { accounts } = await loadAccounts();
    expect(accounts[0]).toMatchObject({ provider: 'claude', command: 'claude' });
  });

  it('writes atomically and leaves no temp files', async () => {
    await saveAccounts({
      accounts: [{ id: 'a', label: 'A', config_dir: '/x', provider: 'claude', command: 'claude' }],
    });
    await saveAccounts({
      accounts: [{ id: 'b', label: 'B', config_dir: '/y', provider: 'claude', command: 'c' }],
    });
    expect(await readdir(process.env.WINGMAN_HOME as string)).toEqual(['accounts.json']);
    expect((await loadAccounts()).accounts[0]?.id).toBe('b');
    expect(await mode(accountsFile())).toBe(0o600);
  });

  it('rejects invalid files and duplicate ids', async () => {
    await mkdir(process.env.WINGMAN_HOME as string, { recursive: true });
    await writeFile(accountsFile(), '{"accounts": 3}');
    await expect(loadAccounts()).rejects.toThrow(/invalid/);
    await expect(
      saveAccounts({
        accounts: [
          { id: 'a', label: 'A', config_dir: '/x', provider: 'claude', command: 'claude' },
          { id: 'a', label: 'B', config_dir: '/y', provider: 'claude', command: 'claude' },
        ],
      }),
    ).rejects.toThrow(/duplicate/);
  });

  it('getAccount throws a clear error for an unknown id', async () => {
    await saveAccounts({
      accounts: [{ id: 'a', label: 'A', config_dir: '/x', provider: 'claude', command: 'claude' }],
    });
    expect((await getAccount('a')).label).toBe('A');
    await expect(getAccount('nope')).rejects.toThrow(/Unknown account "nope".*a/);
  });

  it('targetsFor excludes the caller, including via a symlinked config dir', async () => {
    const real = join(root, 'real');
    const other = join(root, 'other');
    const link = join(root, 'link');
    await mkdir(real);
    await mkdir(other);
    await symlink(real, link);
    await saveAccounts({
      accounts: [
        { id: 'me', label: 'Me', config_dir: link, provider: 'claude', command: 'claude' },
        { id: 'them', label: 'Them', config_dir: other, provider: 'claude', command: 'claude' },
      ],
    });
    expect((await targetsFor(real)).map((a) => a.id)).toEqual(['them']);
    expect((await targetsFor(callerProfile({ CLAUDE_CONFIG_DIR: link }))).map((a) => a.id)).toEqual(
      ['them'],
    );
    expect((await targetsFor(join(root, 'unrelated'))).map((a) => a.id)).toEqual(['me', 'them']);
  });
});

describe('weighted selection', () => {
  const acct = (id: string, weight?: number): Account => ({
    id,
    label: id,
    config_dir: join(root, id),
    provider: 'claude',
    command: 'claude',
    ...(weight !== undefined ? { weight } : {}),
  });

  it('defaults the weight to 1', () => {
    expect(weightOf(acct('a'))).toBe(1);
    expect(weightOf(acct('a', 70))).toBe(70);
  });

  it('splits the unit interval in proportion to the weights', () => {
    const pool = [acct('a', 70), acct('b', 30)];
    expect(pickWeighted(pool, () => 0)?.id).toBe('a');
    expect(pickWeighted(pool, () => 0.6999)?.id).toBe('a');
    expect(pickWeighted(pool, () => 0.7)?.id).toBe('b');
    expect(pickWeighted(pool, () => 0.9999)?.id).toBe('b');
  });

  it('treats an unset weight as 1 next to explicit weights', () => {
    const pool = [acct('a'), acct('b', 3)];
    expect(pickWeighted(pool, () => 0.24)?.id).toBe('a');
    expect(pickWeighted(pool, () => 0.26)?.id).toBe('b');
  });

  it('never picks weight 0 and returns undefined when nothing can be picked', () => {
    expect(pickWeighted([acct('a', 0), acct('b', 1)], () => 0)?.id).toBe('b');
    expect(pickWeighted([acct('a', 0)], () => 0)).toBeUndefined();
    expect(pickWeighted([], () => 0)).toBeUndefined();
  });

  it('approaches the requested ratio over many draws', () => {
    const pool = [acct('a', 70), acct('b', 30)];
    let a = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) if (pickWeighted(pool, () => (i + 0.5) / n)?.id === 'a') a++;
    expect(a / n).toBeCloseTo(0.7, 2);
  });

  it('rejects weights that are negative, non-numeric or large enough to overflow the total', async () => {
    for (const weight of [-1, '5', 1e308, 1000001]) {
      await expect(
        saveAccounts({ accounts: [{ ...acct('a'), weight } as unknown as Account] }),
      ).rejects.toThrow();
    }
    await saveAccounts({ accounts: [acct('a', 1e6), acct('b', 1e6)] });
    expect(pickWeighted((await loadAccounts()).accounts, () => 0.99)?.id).toBe('b');
  });

  it('persists a weight, removes it again and rejects a negative one', async () => {
    await saveAccounts({ accounts: [acct('a')] });
    await setWeight('a', 5);
    expect((await getAccount('a')).weight).toBe(5);
    await setWeight('a', undefined);
    expect((await getAccount('a')).weight).toBeUndefined();
    await expect(setWeight('a', -1)).rejects.toThrow();
    await expect(setWeight('nope', 1)).rejects.toThrow(/nope/);
  });
});
