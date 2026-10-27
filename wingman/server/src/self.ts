import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

export function callerProfile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return canonical(configured ? configured : join(homedir(), '.claude'));
}

export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WINGMAN_DEPTH;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return 0;
  return Number.parseInt(raw.trim(), 10);
}

export function assertCanStart(env: NodeJS.ProcessEnv = process.env, limit = 1): void {
  const depth = currentDepth(env);
  if (depth >= limit) {
    throw new Error(
      `Refusing to start a nested run: WINGMAN_DEPTH=${depth} has reached the limit of ${limit}`,
    );
  }
}
