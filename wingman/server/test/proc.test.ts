import { describe, expect, it } from 'vitest';
import {
  backendFor,
  isSameProcess,
  procfsBackend,
  psBackend,
  readStartTime,
  type PsExec,
} from '../src/proc.js';

function fakePs(outputs: Record<string, string | Error>): { exec: PsExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: PsExec = (file, args) => {
    calls.push([file, ...args]);
    const out = outputs[args.join(' ')];
    if (out === undefined || out instanceof Error) throw out ?? new Error('unexpected ps call');
    return out;
  };
  return { exec, calls };
}

describe('psBackend', () => {
  it('normalizes the lstart output into a stable string', () => {
    const { exec, calls } = fakePs({ '-o lstart= -p 42': 'Mon Oct  7 09:05:01 2026\n' });
    expect(psBackend(exec).startTime(42)).toBe('Mon Oct 7 09:05:01 2026');
    expect(calls).toEqual([['ps', '-o', 'lstart=', '-p', '42']]);
  });

  it('gives the same string for a one-digit day with one or two spaces', () => {
    const a = psBackend(fakePs({ '-o lstart= -p 1': 'Mon Oct  7 09:05:01 2026' }).exec);
    const b = psBackend(fakePs({ '-o lstart= -p 1': 'Mon Oct 7 09:05:01 2026' }).exec);
    expect(a.startTime(1)).toBe(b.startTime(1));
  });

  it('returns undefined for empty output, a failing ps or a bad pid', () => {
    expect(psBackend(fakePs({ '-o lstart= -p 5': '\n' }).exec).startTime(5)).toBeUndefined();
    expect(psBackend(fakePs({ '-o lstart= -p 5': new Error('exit 1') }).exec).startTime(5)).toBe(
      undefined,
    );
    const { exec, calls } = fakePs({});
    expect(psBackend(exec).startTime(-1)).toBeUndefined();
    expect(psBackend(exec).startTime(Number.NaN)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  const TABLE = [
    '  PID  PGID STAT',
    '  100   100 Ss',
    '  101   100 S+',
    '  102   100 Z',
    '  103   100 Z+',
    '  200   200 S',
    'garbage line',
    '  300',
    '  abc   100 S',
    '',
  ].join('\n');

  it('lists live members of a group, skipping zombies, headers and malformed lines', () => {
    const { exec, calls } = fakePs({ '-A -o pid=,pgid=,stat=': TABLE });
    expect(psBackend(exec).groupMembers(100)).toEqual([100, 101]);
    expect(psBackend(exec).groupMembers(200)).toEqual([200]);
    expect(psBackend(exec).groupMembers(999)).toEqual([]);
    expect(calls[0]).toEqual(['ps', '-A', '-o', 'pid=,pgid=,stat=']);
  });

  it('returns no members for empty output or a failing ps', () => {
    expect(psBackend(fakePs({ '-A -o pid=,pgid=,stat=': '' }).exec).groupMembers(1)).toEqual([]);
    expect(
      psBackend(fakePs({ '-A -o pid=,pgid=,stat=': new Error('boom') }).exec).groupMembers(1),
    ).toEqual([]);
  });
});

describe('isSameProcess with a backend', () => {
  const backend = (start: string | undefined) => ({
    startTime: () => start,
    groupMembers: () => [],
  });

  it('is true for the same start time and false when the pid was reused', () => {
    expect(isSameProcess(process.pid, 'T1', backend('T1'))).toBe(true);
    expect(isSameProcess(process.pid, 'T1', backend('T2'))).toBe(false);
  });

  it('is true when the start time cannot be read, or none was recorded', () => {
    expect(isSameProcess(process.pid, 'T1', backend(undefined))).toBe(true);
    expect(isSameProcess(process.pid, undefined, backend('T2'))).toBe(true);
  });

  it('is false for a dead pid whatever the start time', () => {
    expect(isSameProcess(2 ** 22 + 12345, undefined, backend('T1'))).toBe(false);
  });
});

describe('backendFor', () => {
  it('uses /proc on linux and ps elsewhere', () => {
    const { exec } = fakePs({ '-o lstart= -p 9': 'Tue Jan  2 03:04:05 2026' });
    expect(backendFor('darwin', exec).startTime(9)).toBe('Tue Jan 2 03:04:05 2026');
    expect(backendFor('freebsd', exec).startTime(9)).toBe('Tue Jan 2 03:04:05 2026');
    if (process.platform === 'linux') {
      expect(backendFor('linux', exec).startTime(process.pid)).toBe(
        procfsBackend().startTime(process.pid),
      );
      expect(readStartTime(process.pid)).toBe(procfsBackend().startTime(process.pid));
    }
  });
});
