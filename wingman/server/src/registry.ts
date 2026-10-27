import { randomBytes } from 'node:crypto';
import { chmod, mkdir, realpath, rename, writeFile, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { accountsFile } from './paths.js';
import type { Account } from './types.js';

const accountSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  config_dir: z.string().min(1),
  provider: z.string().min(1).default('claude'),
  command: z.string().min(1).default('claude'),
});

const registrySchema = z.object({ accounts: z.array(accountSchema) });

export interface Registry {
  accounts: Account[];
}

export async function saveAccounts(registry: Registry): Promise<void> {
  const parsed = registrySchema.parse(registry);
  const ids = parsed.accounts.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new Error('accounts.json has duplicate account ids');

  const file = accountsFile();
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function loadAccounts(): Promise<Registry> {
  const file = accountsFile();
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const empty: Registry = { accounts: [] };
    await saveAccounts(empty);
    return empty;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`accounts.json at ${file} is not valid JSON`);
  }
  const result = registrySchema.safeParse(json);
  if (!result.success) {
    throw new Error(`accounts.json at ${file} is invalid: ${result.error.message}`);
  }
  return result.data;
}

export async function getAccount(id: string): Promise<Account> {
  const { accounts } = await loadAccounts();
  const found = accounts.find((a) => a.id === id);
  if (!found) {
    const known = accounts.map((a) => a.id).join(', ') || 'none';
    throw new Error(`Unknown account "${id}". Registered accounts: ${known}`);
  }
  return found;
}

async function canonical(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

export async function targetsFor(callerProfileDir: string): Promise<Account[]> {
  const { accounts } = await loadAccounts();
  const caller = await canonical(callerProfileDir);
  const result: Account[] = [];
  for (const account of accounts) {
    if ((await canonical(account.config_dir)) !== caller) result.push(account);
  }
  return result;
}
