import { readFileSync, readdirSync } from 'node:fs';

export function readStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19];
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when pid is alive and, where /proc exposes it, still the process that started at `startTime`. */
export function isSameProcess(pid: number, startTime: string | undefined): boolean {
  if (!isAlive(pid)) return false;
  if (startTime === undefined) return true;
  const actual = readStartTime(pid);
  return actual === undefined || actual === startTime;
}

const GROUP_KILL_GRACE_MS = 3000;

/** Live (non-zombie) processes whose process group id is `pgid`, from /proc. */
export function groupMembers(pgid: number): number[] {
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
}

/**
 * True when the group leader `pgid` is gone but members of its group still run. The kernel never
 * reuses a pid while it is still a process group id, so a reused leader pid cannot be mistaken
 * for the old group: only a dead leader with a surviving group qualifies.
 */
export function hasOrphanedGroup(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1 || isAlive(pgid)) return false;
  const members = groupMembers(pgid);
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
