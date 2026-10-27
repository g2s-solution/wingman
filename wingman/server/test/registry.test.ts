import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountsFile } from '../src/paths.js';
import { callerProfile } from '../src/self.js';
import { getAccount, loadAccounts, saveAccounts, targetsFor } from '../src/registry.js';

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
