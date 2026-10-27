import { readFileSync } from 'node:fs';

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
