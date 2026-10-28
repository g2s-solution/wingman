import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  clearLimited,
  effectiveStatus,
  isLimited,
  loadAccounts,
  markLimited,
  saveAccounts,
} from './registry.js';
import { runCountsByAccount, type AccountRunCounts } from './runs.js';
import { callerProfile, canonical } from './self.js';
import type { Account } from './types.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const USAGE = `usage: wingman accounts list [--json]
       wingman accounts add --id ID --config-dir DIR [--label L] [--command CMD] [--provider P] [--upsert]
       wingman accounts disable ID
       wingman accounts enable ID
       wingman accounts mark-limited ID --until <ISO time with Z or offset, or epoch seconds>
       wingman accounts clear-limited ID
       wingman accounts remove ID --yes`;

class AccountsUsageError extends Error {}

export type Clock = () => Date;

export interface AccountRow {
  id: string;
  label: string;
  status: string;
  /** Present only while the account is limited. */
  limited_until?: string;
  provider: string;
  config_dir: string;
  command: string;
  is_caller: boolean;
  runs: AccountRunCounts;
}

/** Account fields safe to show a model: no command, no paths. */
export interface PublicAccount {
  id: string;
  label: string;
  status: string;
  limited_until?: string;
  is_caller: boolean;
  provider: string;
  runs: AccountRunCounts;
}

export function accountRows(
  accounts: Account[],
  caller: string,
  now: Date = new Date(),
  counts: Record<string, AccountRunCounts> = runCountsByAccount(),
): AccountRow[] {
  return accounts.map((a) => ({
    id: a.id,
    label: a.label,
    status: effectiveStatus(a, now),
    ...(isLimited(a, now) && a.limited_until !== undefined
      ? { limited_until: a.limited_until }
      : {}),
    provider: a.provider,
    config_dir: a.config_dir,
    command: a.command,
    is_caller: canonical(a.config_dir) === caller,
    runs: counts[a.id] ?? { total: 0, by_status: {} },
  }));
}

export function publicAccounts(
  accounts: Account[],
  caller: string,
  now: Date = new Date(),
  counts?: Record<string, AccountRunCounts>,
): PublicAccount[] {
  return accountRows(accounts, caller, now, counts).map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status,
    ...(r.limited_until !== undefined ? { limited_until: r.limited_until } : {}),
    is_caller: r.is_caller,
    provider: r.provider,
    runs: r.runs,
  }));
}

const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** An ISO date or date-time with an explicit zone (a bare date is UTC), or epoch seconds. */
export function parseUntil(raw: string, now: Date): Date {
  const bad =
    '--until must be an ISO time with Z or an offset (2026-11-01T08:00:00Z), a date (2026-11-01) or epoch seconds';
  let until: Date;
  if (/^\d{1,13}$/.test(raw)) {
    until = new Date(Number(raw) * 1000);
  } else {
    const m = ISO_TIME.exec(raw);
    if (m === null) throw new AccountsUsageError(bad);
    until = new Date(raw.includes('T') ? raw : `${raw}T00:00:00Z`);
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const hour = m[4] === undefined ? 0 : Number(m[4]);
    const minute = m[5] === undefined ? 0 : Number(m[5]);
    const second = m[6] === undefined ? 0 : Number(m[6]);
    const calendar = new Date(Date.UTC(y, mo - 1, d));
    if (
      calendar.getUTCFullYear() !== y ||
      calendar.getUTCMonth() !== mo - 1 ||
      calendar.getUTCDate() !== d ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      throw new AccountsUsageError(bad);
    }
  }
  if (Number.isNaN(until.getTime())) throw new AccountsUsageError(bad);
  if (until.getTime() <= now.getTime()) {
    throw new AccountsUsageError(`--until ${raw} is not in the future`);
  }
  return until;
}

export function normalizeConfigDir(raw: string): string {
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(expanded)) {
    throw new AccountsUsageError('--config-dir must be an absolute path (or start with ~/)');
  }
  return resolve(expanded);
}

interface Parsed {
  positional: string[];
  values: Record<string, string>;
  flags: Set<string>;
}

function parse(args: string[], valueFlags: string[], boolFlags: string[]): Parsed {
  const out: Parsed = { positional: [], values: {}, flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw new AccountsUsageError(`${a} needs a value\n${USAGE}`);
      out.values[a] = v;
    } else if (boolFlags.includes(a)) {
      out.flags.add(a);
    } else if (a.startsWith('-')) {
      throw new AccountsUsageError(`unexpected argument ${a}\n${USAGE}`);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows
    .map((r) =>
      r
        .map((cell, c) => cell.padEnd(widths[c]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function runsCell(runs: AccountRunCounts): string {
  const parts = Object.entries(runs.by_status)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${status}=${n}`);
  return parts.length === 0 ? '-' : parts.join(' ');
}

async function list(args: string[], now: Clock): Promise<number> {
  const p = parse(args, [], ['--json']);
  if (p.positional.length > 0) throw new AccountsUsageError(`unexpected argument\n${USAGE}`);
  const { accounts } = await loadAccounts();
  const rows = accountRows(accounts, callerProfile(), now());
  if (p.flags.has('--json')) {
    write(JSON.stringify(rows, null, 2));
  } else if (rows.length === 0) {
    write('no accounts registered');
  } else {
    write(
      table([
        ['ID', 'LABEL', 'STATUS', 'LIMITED_UNTIL', 'RUNS', 'CONFIG_DIR', 'COMMAND', ''],
        ...rows.map((r) => [
          r.id,
          r.label,
          r.status,
          r.limited_until ?? '-',
          runsCell(r.runs),
          r.config_dir,
          r.command,
          r.is_caller ? 'this profile' : '',
        ]),
      ]),
    );
  }
  return 0;
}

async function limit(
  verb: 'mark-limited' | 'clear-limited',
  args: string[],
  now: Clock,
): Promise<number> {
  const p = parse(args, verb === 'mark-limited' ? ['--until'] : [], []);
  const id = p.positional[0];
  if (id === undefined || p.positional.length > 1) {
    throw new AccountsUsageError(`${verb} needs exactly one account id\n${USAGE}`);
  }
  const registry = await loadAccounts();
  if (!registry.accounts.some((a) => a.id === id)) {
    const known = registry.accounts.map((a) => a.id).join(', ') || 'none';
    throw new AccountsUsageError(`unknown account "${id}". Registered accounts: ${known}`);
  }
  if (verb === 'clear-limited') {
    write((await clearLimited(id)) ? `cleared the limit on ${id}` : `${id} is not marked limited`);
    return 0;
  }
  const raw = p.values['--until'];
  if (raw === undefined) throw new AccountsUsageError(`--until is required\n${USAGE}`);
  const until = parseUntil(raw, now());
  try {
    await markLimited(id, until);
  } catch (err) {
    throw new AccountsUsageError((err as Error).message);
  }
  write(`marked ${id} limited until ${until.toISOString()}`);
  return 0;
}

async function add(args: string[]): Promise<number> {
  const p = parse(
    args,
    ['--id', '--config-dir', '--label', '--command', '--provider'],
    ['--upsert'],
  );
  if (p.positional.length > 0) throw new AccountsUsageError(`unexpected argument\n${USAGE}`);
  const id = p.values['--id'];
  const rawDir = p.values['--config-dir'];
  if (id === undefined || rawDir === undefined) {
    throw new AccountsUsageError(`--id and --config-dir are required\n${USAGE}`);
  }
  if (!ID.test(id)) throw new AccountsUsageError('--id must match [A-Za-z0-9_-]{1,64}');
  const configDir = normalizeConfigDir(rawDir);
  for (const flag of ['--label', '--command', '--provider']) {
    if (p.values[flag] !== undefined && p.values[flag]!.trim() === '') {
      throw new AccountsUsageError(`${flag} must not be empty`);
    }
  }
  const isCaller = canonical(configDir) === callerProfile();

  const registry = await loadAccounts();
  const i = registry.accounts.findIndex((a) => a.id === id);
  if (i >= 0 && !p.flags.has('--upsert')) {
    throw new AccountsUsageError(`account "${id}" already exists; pass --upsert to update it`);
  }
  const given: Partial<Account> = { config_dir: configDir };
  if (p.values['--label'] !== undefined) given.label = p.values['--label'];
  if (p.values['--command'] !== undefined) given.command = p.values['--command'];
  if (p.values['--provider'] !== undefined) given.provider = p.values['--provider'];
  if (i >= 0) {
    registry.accounts[i] = { ...registry.accounts[i]!, ...given };
  } else {
    registry.accounts.push({
      id,
      label: id,
      provider: 'claude',
      command: 'claude',
      ...given,
      config_dir: configDir,
    });
  }
  await saveAccounts(registry);
  write(`${i >= 0 ? 'updated' : 'registered'} ${id}`);
  if (isCaller) {
    write(
      `note: ${id} is the profile you are running in; it is skipped when you delegate from it and used when you delegate from another profile`,
    );
  }
  return 0;
}

async function change(verb: 'disable' | 'enable' | 'remove', args: string[]): Promise<number> {
  const p = parse(args, [], ['--yes']);
  const id = p.positional[0];
  if (id === undefined || p.positional.length > 1) {
    throw new AccountsUsageError(`${verb} needs exactly one account id\n${USAGE}`);
  }
  if (verb !== 'remove' && p.flags.has('--yes')) {
    throw new AccountsUsageError(`unexpected argument --yes\n${USAGE}`);
  }
  const registry = await loadAccounts();
  const i = registry.accounts.findIndex((a) => a.id === id);
  if (i < 0) {
    const known = registry.accounts.map((a) => a.id).join(', ') || 'none';
    throw new AccountsUsageError(`unknown account "${id}". Registered accounts: ${known}`);
  }
  if (verb === 'remove') {
    if (!p.flags.has('--yes')) {
      write(
        `would remove ${id} from the registry (the profile directory and its credentials stay untouched); pass --yes to do it`,
      );
      return 2;
    }
    registry.accounts.splice(i, 1);
    await saveAccounts(registry);
    write(`removed ${id}`);
    return 0;
  }
  const entry = { ...registry.accounts[i]! };
  delete entry.limited_until;
  if (verb === 'disable') entry.status = 'disabled';
  else delete entry.status;
  registry.accounts[i] = entry;
  await saveAccounts(registry);
  write(`${verb}d ${id}`);
  return 0;
}

/** Runs `wingman accounts ...` and returns its exit code; unexpected errors propagate. */
export async function accountsCommand(
  args: string[],
  now: Clock = () => new Date(),
): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case 'list':
        return await list(rest, now);
      case 'mark-limited':
      case 'clear-limited':
        return await limit(sub, rest, now);
      case 'add':
        return await add(rest);
      case 'disable':
      case 'enable':
      case 'remove':
        return await change(sub, rest);
      default:
        throw new AccountsUsageError(USAGE);
    }
  } catch (err) {
    if (err instanceof AccountsUsageError) {
      process.stderr.write(`wingman accounts: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
