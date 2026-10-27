import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeRunCli } from '../src/cli.js';
import { tmp } from './helpers.js';

let home: string;
let saved: string | undefined;
let out: string[];
let err: string[];

beforeEach(() => {
  home = tmp('cli');
  saved = process.env.WINGMAN_HOME;
  process.env.WINGMAN_HOME = home;
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
  if (saved === undefined) delete process.env.WINGMAN_HOME;
  else process.env.WINGMAN_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const cli = (...args: string[]) => maybeRunCli(['node', 'index.js', ...args]);

function writeMeta(id: string, meta: Record<string, unknown>): void {
  const dir = join(home, 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, ...meta }));
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

describe('maybeRunCli', () => {
  it('ignores arguments that are not a CLI command', async () => {
    expect(await cli()).toBeUndefined();
    expect(await cli('--supervise', 'x')).toBeUndefined();
    expect(await cli('nope')).toBeUndefined();
  });

  it.each([
    ['done', 0],
    ['partial', 0],
    ['failed', 1],
    ['needs_input', 1],
  ])('wait on a %s run prints one line and exits %i', async (status, code) => {
    writeMeta('r1', { status });
    expect(await cli('wait', 'r1', '--poll-ms', '10')).toBe(code);
    expect(out).toEqual([`WINGMAN_RUN r1 ${status}\n`]);
  });

  it('wait exits 2 for an unknown run, a bad id and bad options', async () => {
    expect(await cli('wait', 'missing')).toBe(2);
    expect(await cli('wait', '../etc')).toBe(2);
    expect(await cli('wait')).toBe(2);
    expect(await cli('wait', 'r1', '--poll-ms', 'abc')).toBe(2);
    expect(await cli('wait', 'r1', '--bogus')).toBe(2);
    expect(out).toEqual([]);
    expect(err.join('')).toMatch(/wingman wait/);
  });

  it('wait exits 2 when the meta is not a valid status', async () => {
    writeMeta('r2', { status: 'weird' });
    expect(await cli('wait', 'r2', '--poll-ms', '10')).toBe(2);
  });

  it('wait exits 3 on a timeout while the run is alive', async () => {
    writeMeta('r3', { status: 'running', pid: process.pid });
    expect(await cli('wait', 'r3', '--timeout-ms', '80', '--poll-ms', '10')).toBe(3);
    expect(out).toEqual([]);
  });

  it('wait ends a run whose supervisor is gone as failed_no_report and persists it', async () => {
    writeMeta('r4', { status: 'running', pid: deadPid() });
    const code = await cli('wait', 'r4', '--poll-ms', '10', '--grace-ms', '30');
    expect(code).toBe(1);
    expect(out).toEqual(['WINGMAN_RUN r4 failed_no_report\n']);
    const meta = JSON.parse(readFileSync(join(home, 'runs', 'r4', 'meta.json'), 'utf8'));
    expect(meta.status).toBe('failed_no_report');
  });

  it('wait picks up a status written while it polls', async () => {
    writeMeta('r5', { status: 'running', pid: process.pid });
    setTimeout(() => writeMeta('r5', { status: 'done', pid: process.pid }), 60);
    expect(await cli('wait', 'r5', '--poll-ms', '10', '--timeout-ms', '5000')).toBe(0);
    expect(out).toEqual(['WINGMAN_RUN r5 done\n']);
  });

  it('gc prints counts for a dry run and a real run, and rejects bad arguments', async () => {
    expect(await cli('gc', '--dry-run')).toBe(0);
    expect(out.join('')).toMatch(
      /wingman gc \(dry run\): would remove 0 runs, keep 0, prune 0 worktrees/,
    );
    out.length = 0;
    expect(await cli('gc', '--older-than-days', '7')).toBe(0);
    expect(out.join('')).toMatch(/^wingman gc: removed 0 runs/);
    expect(await cli('gc', '--bogus')).toBe(2);
    expect(await cli('gc', '--older-than-days')).toBe(2);
    expect(await cli('gc', '--older-than-days', '-3')).toBe(2);
  });
});
