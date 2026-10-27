import { homedir } from 'node:os';
import { join } from 'node:path';

export function wingmanHome(): string {
  return process.env.WINGMAN_HOME || join(homedir(), '.wingman');
}

export const accountsFile = (): string => join(wingmanHome(), 'accounts.json');
export const runsDir = (): string => join(wingmanHome(), 'runs');
export const runDir = (id: string): string => join(runsDir(), id);
export const worktreesDir = (): string => join(wingmanHome(), 'worktrees');
