import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

/** What the rest of the module needs from the operating system's process table. */
export interface ProcBackend {
  /** A string that is stable for the life of the process and differs for a later process with the same pid. */
  startTime(pid: number): string | undefined;
  /** Live (non-zombie) processes whose process group id is `pgid`. */
  groupMembers(pgid: number): number[];
}

/** Runs `file` with a fixed argument list and returns stdout; throws when it fails. */
export type PsExec = (file: string, args: string[]) => string;

const defaultPsExec: PsExec = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });

export function procfsBackend(): ProcBackend {
  return {
    startTime(pid) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return rest[19];
      } catch {
        return undefined;
      }
    },
    groupMembers(pgid) {
      let names: string[];
      try {
        names = readdirSync('/proc');
      } catch {
        return [];
      }
      const members: number[] = [];
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
          const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          if (rest[0] !== 'Z' && Number(rest[2]) === pgid) members.push(Number(name));
        } catch {
          // the process ended while scanning
        }
      }
      return members;
    },
  };
}

/** macOS and other POSIX systems without /proc: reads the process table through `ps`. */
export function psBackend(exec: PsExec = defaultPsExec): ProcBackend {
  return {
    startTime(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      try {
        // lstart pads the day of month with a variable number of spaces
        const out = exec('ps', ['-o', 'lstart=', '-p', String(pid)])
          .trim()
          .replace(/\s+/g, ' ');
        return out === '' ? undefined : out;
      } catch {
        return undefined;
      }
    },
    groupMembers(pgid) {
      let out: string;
      try {
        out = exec('ps', ['-A', '-o', 'pid=,pgid=,stat=']);
      } catch {
        return [];
      }
      const members: number[] = [];
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
        if (!m || m[3]!.startsWith('Z')) continue;
        if (Number(m[2]) === pgid) members.push(Number(m[1]));
      }
      return members;
    },
  };
}

export function backendFor(platform: NodeJS.Platform, exec?: PsExec): ProcBackend {
  return platform === 'linux' ? procfsBackend() : psBackend(exec);
}

let current: ProcBackend | undefined;

function defaultBackend(): ProcBackend {
  current ??= backendFor(process.platform);
  return current;
}

export function readStartTime(
  pid: number,
  backend: ProcBackend = defaultBackend(),
): string | undefined {
  return backend.startTime(pid);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when pid is alive and, where the start time can be read, still the process that started at `startTime`. */
export function isSameProcess(
  pid: number,
  startTime: string | undefined,
  backend: ProcBackend = defaultBackend(),
): boolean {
  if (!isAlive(pid)) return false;
  if (startTime === undefined) return true;
  const actual = backend.startTime(pid);
  return actual === undefined || actual === startTime;
}

const GROUP_KILL_GRACE_MS = 3000;

/** Live (non-zombie) processes whose process group id is `pgid`. */
export function groupMembers(pgid: number, backend: ProcBackend = defaultBackend()): number[] {
  return backend.groupMembers(pgid);
}

/**
 * True when the group leader `pgid` is gone but members of its group still run. The kernel never
 * reuses a pid while it is still a process group id, so a reused leader pid cannot be mistaken
 * for the old group: only a dead leader with a surviving group qualifies.
 */
export function hasOrphanedGroup(pgid: number, backend: ProcBackend = defaultBackend()): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1 || isAlive(pgid)) return false;
  const members = backend.groupMembers(pgid);
  return members.length > 0 && !members.includes(process.pid);
}

/** SIGTERM to an orphaned group now, SIGKILL after a grace period if it is still there. */
export function terminateOrphanedGroup(
  pgid: number,
  graceMs: number = GROUP_KILL_GRACE_MS,
): boolean {
  if (!hasOrphanedGroup(pgid)) return false;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return false;
  }
  setTimeout(() => {
    if (!hasOrphanedGroup(pgid)) return;
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, graceMs).unref();
  return true;
}
