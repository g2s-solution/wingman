import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRun, readMeta, updateStatus, writeMeta } from '../src/runs.js';
import { reconcile } from '../src/reconcile.js';
import { createHandlers } from '../src/tools.js';
import { cancelRun } from '../src/runner.js';
import type { RunMeta } from '../src/types.js';
import { tmp } from './helpers.js';

let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.WINGMAN_HOME;
  home = tmp('home');
  process.env.WINGMAN_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.WINGMAN_HOME;
  else process.env.WINGMAN_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function running(patch: Partial<RunMeta> = {}): RunMeta {
  const meta = createRun({ account: 'a', cwd: home, session_id: 's', depth: 1, prompt_chars: 1 });
  const next: RunMeta = { ...meta, ...patch };
  writeMeta(next);
  return next;
}

describe('reconcile', () => {
  it('leaves a live run and terminal runs alone', () => {
    const live = running({ pid: process.pid });
    expect(reconcile(live).status).toBe('running');
    const done = updateStatus(running({ pid: deadPid() }).id, 'done');
    expect(reconcile(done).status).toBe('done');
  });

  it('ends a run with a dead pid or a reused pid, and persists it', () => {
    const dead = running({ pid: deadPid() });
    expect(reconcile(dead).status).toBe('failed_no_report');
    expect(readMeta(dead.id).status).toBe('failed_no_report');
    expect(readMeta(dead.id).finished_at).toBeTruthy();
    const reused = running({ pid: process.pid, pid_start_time: '1' });
    expect(reconcile(reused).status).toBe('failed_no_report');
  });

  it('ends a run with no pid only after the grace', () => {
    const fresh = running();
    expect(reconcile(fresh).status).toBe('running');
    expect(reconcile(fresh, { now: Date.now() + 60 * 60 * 1000 }).status).toBe('failed_no_report');
    const other = running();
    expect(
      reconcile(other, { noPidGraceMs: 10 * 60 * 1000, now: Date.now() + 11 * 60 * 1000 }),
    ).toMatchObject({ status: 'failed_no_report' });
  });
});

describe('tool paths reconcile without waitForRun', () => {
  it('status, result, list, cancel and cleanup see a dead run as failed_no_report', async () => {
    const h = createHandlers({ env: { PATH: process.env.PATH } });
    const ids = [1, 2, 3, 4].map(() => running({ pid: deadPid() }).id);
    expect((await h.status({ run_id: ids[0]! })).status).toBe('failed_no_report');
    expect((await h.result({ run_id: ids[1]! })).status).toBe('failed_no_report');
    expect((await h.cancel({ run_id: ids[2]! })).reason).toMatch(/failed_no_report/);
    expect((await h.cleanup({ run_id: ids[3]!, action: 'discard' })).run_id).toBe(ids[3]);
    const listed = (h.list({}).runs as { id: string; status: string }[]).map((r) => r.status);
    expect(listed.every((st) => st === 'failed_no_report')).toBe(true);
  });

  it('cancelRun reconciles too', async () => {
    const a = running({ pid: deadPid() });
    expect(await cancelRun(a.id)).toMatchObject({ cancelled: false });
    expect(readMeta(a.id).status).toBe('failed_no_report');
    expect(existsSync(home)).toBe(true);
  });
});
