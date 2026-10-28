import { randomBytes } from 'node:crypto';
import { chmod, mkdir, realpath, rename, writeFile, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { accountsFile } from './paths.js';
import type { Account } from './types.js';

// passthrough: a write-back must not drop keys a newer version or a hand edit added
const accountSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    config_dir: z.string().min(1),
    provider: z.string().min(1).default('claude'),
    command: z.string().min(1).default('claude'),
    status: z.string().min(1).optional(),
    limited_until: z.string().min(1).optional(),
  })
  .passthrough();

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

type Limitable = Pick<Account, 'status' | 'limited_until'>;

export const RATE_LIMITED = 'rate_limited';

/**
 * Limited while `limited_until` is in the future. A `rate_limited` entry with no end stays limited
 * until `clear-limited`; an unparsable end counts as expired, so a bad value never locks an account.
 */
export function isLimited(account: Limitable, now: Date = new Date()): boolean {
  if (account.status !== RATE_LIMITED) return false;
  if (account.limited_until === undefined) return true;
  const until = Date.parse(account.limited_until);
  return !Number.isNaN(until) && until > now.getTime();
}

/** The status as seen now: an expired limit reads as `active` without rewriting the file. */
export function effectiveStatus(account: Limitable, now: Date = new Date()): string {
  if (account.status === RATE_LIMITED) return isLimited(account, now) ? RATE_LIMITED : 'active';
  return account.status ?? 'active';
}

export function isActive(account: Limitable, now: Date = new Date()): boolean {
  return effectiveStatus(account, now) === 'active';
}

function indexOfAccount(registry: Registry, id: string): number {
  const i = registry.accounts.findIndex((a) => a.id === id);
  if (i < 0) {
    const known = registry.accounts.map((a) => a.id).join(', ') || 'none';
    throw new Error(`Unknown account "${id}". Registered accounts: ${known}`);
  }
  return i;
}

/** Marks an account limited until `until`; refuses a disabled (or unknown-status) account. */
export async function markLimited(id: string, until: Date): Promise<void> {
  const registry = await loadAccounts();
  const i = indexOfAccount(registry, id);
  const account = registry.accounts[i]!;
  if (
    account.status !== undefined &&
    account.status !== 'active' &&
    account.status !== RATE_LIMITED
  ) {
    throw new Error(`Account "${id}" is ${account.status}; enable it before marking it limited`);
  }
  registry.accounts[i] = { ...account, status: RATE_LIMITED, limited_until: until.toISOString() };
  await saveAccounts(registry);
}

/** Removes the limit; returns false when the account was not marked limited. */
export async function clearLimited(id: string): Promise<boolean> {
  const registry = await loadAccounts();
  const i = indexOfAccount(registry, id);
  const entry = { ...registry.accounts[i]! };
  if (entry.status !== RATE_LIMITED) return false;
  delete entry.status;
  delete entry.limited_until;
  registry.accounts[i] = entry;
  await saveAccounts(registry);
  return true;
}

/**
 * Writes a run's rate limit back to its account: `resetsAt` is a unix timestamp in seconds.
 * Does nothing without a usable future reset time, or for a disabled or unknown account.
 */
export async function recordRateLimit(
  id: string,
  info: { resetsAt?: number | undefined } | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  const resets = info?.resetsAt;
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets * 1000 <= now.getTime()) {
    return false;
  }
  try {
    await markLimited(id, new Date(resets * 1000));
    return true;
  } catch {
    return false;
  }
}
