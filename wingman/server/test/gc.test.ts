import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGc } from '../src/gc.js';
import { createRun, updateStatus, writeResult } from '../src/runs.js';
import { tmp } from './helpers.js';

const BIN = resolve(__dirname, '../../bin/wingman');
const DAY = 24 * 60 * 60 * 1000;

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = tmp('gc');
  savedHome = process.env.WINGMAN_HOME;
  process.env.WINGMAN_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.WINGMAN_HOME;
  else process.env.WINGMAN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function newRun(): string {
  return createRun({ account: 'a', cwd: home, session_id: 's', depth: 0, prompt_chars: 1 }).id;
}

function finishedRun(daysAgo: number, status: 'done' | 'failed' = 'done'): string {
  const id = newRun();
  writeResult(id, 'report');
  writeFileSync(join(home, 'runs', id, 'events.jsonl'), '{}\n');
  updateStatus(id, status, { finished_at: new Date(Date.now() - daysAgo * DAY).toISOString() });
  return id;
}

function runDirOf(id: string): string {
  return join(home, 'runs', id);
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function writeLock(name: string, info: Record<string, unknown>): string {
  mkdirSync(join(home, 'locks'), { recursive: true });
  const path = join(home, 'locks', `${name}.lock`);
  writeFileSync(path, JSON.stringify(info));
  return path;
}

describe('runGc', () => {
  it('removes an old terminal run entirely and keeps a young one', async () => {
    const old = finishedRun(40);
    const young = finishedRun(5);
    const r = await runGc({ olderThanDays: 30 });
    expect(r).toMatchObject({ runsRemoved: 1, runsKept: 1 });
    expect(existsSync(runDirOf(old))).toBe(false);
    expect(existsSync(join(runDirOf(young), 'meta.json'))).toBe(true);
    expect(existsSync(join(runDirOf(young), 'result.md'))).toBe(true);
  });

  it('defaults to 30 days', async () => {
    const a = finishedRun(29);
    const b = finishedRun(31, 'failed');
    await runGc();
    expect(existsSync(runDirOf(a))).toBe(true);
    expect(existsSync(runDirOf(b))).toBe(false);
  });

  it('never touches a running run, however old', async () => {
    const id = newRun();
    const r = await runGc({ olderThanDays: 0 });
    expect(r.runsRemoved).toBe(0);
    expect(existsSync(runDirOf(id))).toBe(true);
  });

  it('counts a dead run as terminal but young: it is ended, not removed', async () => {
    const id = newRun();
    const dir = runDirOf(id);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, pid: deadPid() }));
    const r = await runGc({ olderThanDays: 30 });
    expect(r.runsRemoved).toBe(0);
    const after = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    expect(after.status).toBe('failed_no_report');
  });

  it('dry run changes nothing and reports the same counts', async () => {
    const old = finishedRun(40);
    finishedRun(1);
    const running = newRun();
    const lock = writeLock('gone', { pid: deadPid(), run_id: 'nope', repo: '/x', lock_key: 'k' });
    const dry = await runGc({ olderThanDays: 30, dryRun: true });
    expect(dry).toMatchObject({ runsRemoved: 1, runsKept: 2, locksRemoved: 1 });
    expect(existsSync(runDirOf(old))).toBe(true);
    expect(existsSync(runDirOf(running))).toBe(true);
    expect(existsSync(lock)).toBe(true);
    const real = await runGc({ olderThanDays: 30 });
    expect(real).toEqual(dry);
    expect(existsSync(runDirOf(old))).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it('dry run does not end a dead run', async () => {
    const id = newRun();
    const dir = runDirOf(id);
    const file = join(dir, 'meta.json');
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...meta, pid: deadPid() }));
    await runGc({ dryRun: true });
    expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('running');
  });

  it('removes a lock whose owner is gone and keeps one held by a live run', async () => {
    const id = newRun();
    const stale = writeLock('stale', { pid: deadPid(), run_id: id, repo: '/x', lock_key: 'a' });
    const orphan = writeLock('orphan', {
      pid: process.pid,
      run_id: 'gone',
      repo: '/x',
      lock_key: 'b',
    });
    const live = writeLock('live', { pid: process.pid, run_id: id, repo: '/x', lock_key: 'c' });
    const r = await runGc();
    expect(r.locksRemoved).toBe(2);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('keeps a fresh unparsable lock and removes an old one', async () => {
    mkdirSync(join(home, 'locks'), { recursive: true });
    const fresh = join(home, 'locks', 'fresh.lock');
    const old = join(home, 'locks', 'old.lock');
    writeFileSync(fresh, '');
    writeFileSync(old, '{broken');
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    const r = await runGc();
    expect(r.locksRemoved).toBe(1);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it('survives a run directory without a valid meta.json: leaves it and counts it', async () => {
    mkdirSync(join(home, 'runs', 'broken'), { recursive: true });
    writeFileSync(join(home, 'runs', 'broken', 'meta.json'), '{not json');
    mkdirSync(join(home, 'runs', 'empty'), { recursive: true });
    const old = finishedRun(90);
    const r = await runGc({ olderThanDays: 30 });
    expect(r).toMatchObject({ runsRemoved: 1, runsKept: 2, runsUnreadable: 2 });
    expect(existsSync(join(home, 'runs', 'broken', 'meta.json'))).toBe(true);
    expect(existsSync(join(home, 'runs', 'empty'))).toBe(true);
    expect(existsSync(runDirOf(old))).toBe(false);
  });

  it('works when WINGMAN_HOME has no runs or locks yet', async () => {
    expect(await runGc()).toEqual({
      runsRemoved: 0,
      runsKept: 0,
      runsUnreadable: 0,
      worktreesPruned: 0,
      locksRemoved: 0,
    });
  });
});

describe('wingman gc (CLI)', () => {
  function cli(args: string[]) {
    const r = spawnSync(process.execPath, [BIN, 'gc', ...args], {
      env: { ...process.env, WINGMAN_HOME: home },
      encoding: 'utf8',
      timeout: 20000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it('prints counts only and exits 0', () => {
    finishedRun(40);
    finishedRun(1);
    const r = cli(['--older-than-days', '30']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('wingman gc: removed 1 runs, kept 1, pruned 0 worktrees, removed 0 locks\n');
  });

  it('prints "would remove" for --dry-run', () => {
    const old = finishedRun(40);
    const r = cli(['--dry-run']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      'wingman gc (dry run): would remove 1 runs, keep 0, prune 0 worktrees, remove 0 locks\n',
    );
    expect(existsSync(runDirOf(old))).toBe(true);
  });

  it('exits 2 on bad arguments and prints nothing on stdout', () => {
    for (const args of [
      ['--bogus'],
      ['extra'],
      ['--older-than-days'],
      ['--older-than-days', 'x'],
      ['--older-than-days', '-1'],
    ]) {
      const r = cli(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.out).toBe('');
    }
  });

  it('the launcher rejects an unknown subcommand without starting the server', () => {
    const r = spawnSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });
});
