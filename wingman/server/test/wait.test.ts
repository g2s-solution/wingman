import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmp } from './helpers.js';

const SCRIPT = resolve(__dirname, '../../bin/wingman-wait');

let home: string;

beforeEach(() => {
  home = tmp('wait');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeMeta(id: string, meta: Record<string, unknown>): void {
  const dir = join(home, 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, ...meta }));
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, WINGMAN_HOME: home },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid;
}

describe('wingman-wait', () => {
  const cases: [string, number][] = [
    ['done', 0],
    ['partial', 0],
    ['blocked', 1],
    ['needs_input', 1],
    ['needs_caller', 1],
    ['failed', 1],
    ['failed_no_report', 1],
    ['rate_limited', 1],
    ['cancelled', 1],
  ];
  it.each(cases)('terminal status %s exits %i with exactly one line', (status, code) => {
    writeMeta('r1', { status, result: 'SECRET-LOOKING TEXT' });
    const r = run(['r1', '--poll-ms', '20']);
    expect(r.code).toBe(code);
    expect(r.out).toBe(`WINGMAN_RUN r1 ${status}\n`);
  });

  it('waits for a run that flips to done', async () => {
    writeMeta('r2', { status: 'running', pid: process.pid });
    const child = spawn(process.execPath, [SCRIPT, 'r2', '--poll-ms', '20'], {
      env: { ...process.env, WINGMAN_HOME: home },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((res) => child.on('exit', res));
    await new Promise((r) => setTimeout(r, 300));
    expect(out).toBe('');
    writeMeta('r2', { status: 'done', pid: process.pid });
    expect(await exited).toBe(0);
    expect(out).toBe('WINGMAN_RUN r2 done\n');
  });

  it('exits 2 for an unknown run', () => {
    const r = run(['nope']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
  });

  it('exits 2 for a bad id or missing id', () => {
    for (const args of [['../etc'], ['a/b'], ['x'.repeat(65)], []]) {
      const r = run(args);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
    }
  });

  it('exits 2 for unreadable meta', () => {
    const dir = join(home, 'runs', 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), '{not json');
    const r = run(['bad', '--poll-ms', '10']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
  });

  it('exits 3 on timeout and prints nothing', () => {
    writeMeta('r3', { status: 'running', pid: process.pid });
    const r = run(['r3', '--timeout-ms', '200', '--poll-ms', '20']);
    expect(r.code).toBe(3);
    expect(r.out).toBe('');
  });

  it('reports failed_no_report after the grace when the pid is dead', () => {
    writeMeta('r4', { status: 'running', pid: deadPid() });
    const r = run(['r4', '--poll-ms', '20', '--grace-ms', '200']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('WINGMAN_RUN r4 failed_no_report\n');
  });

  it('prefers a status written during the grace over failed_no_report', async () => {
    writeMeta('r5', { status: 'running', pid: deadPid() });
    const child = spawn(process.execPath, [SCRIPT, 'r5', '--poll-ms', '20', '--grace-ms', '3000'], {
      env: { ...process.env, WINGMAN_HOME: home },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((res) => child.on('exit', res));
    await new Promise((r) => setTimeout(r, 200));
    writeMeta('r5', { status: 'partial', pid: 1 });
    expect(await exited).toBe(0);
    expect(out).toBe('WINGMAN_RUN r5 partial\n');
  });
});
