import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import type { Account } from '../src/types.js';

export const FAKE = resolve(__dirname, 'fixtures/fake-claude.mjs');

export function tmp(prefix: string): string {
  // realpath: on macOS the temp dir sits behind a /var -> /private/var symlink, and the server reports real paths
  return realpathSync(mkdtempSync(join(tmpdir(), `wm-${prefix}-`)));
}

export async function bundleSupervisor(dir: string): Promise<string> {
  const outfile = join(dir, 'supervisor.mjs');
  await build({
    entryPoints: [resolve(__dirname, '../src/supervisor-main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    banner: {
      js: "import { createRequire as __r } from 'node:module';\nconst require = __r(import.meta.url);",
    },
  });
  return outfile;
}

/** A launcher script, like a real profile launcher: it adds the fake's behaviour variables itself. */
export function makeLauncher(dir: string, mode: string, log: string, extraExports = ''): string {
  const path = join(dir, `launcher-${mode}.sh`);
  writeFileSync(
    path,
    `#!/bin/sh\nexport FAKE_CLAUDE_MODE=${mode} FAKE_CLAUDE_LOG=${log}\n${extraExports}\nexec "${process.execPath}" "${FAKE}" "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

export function makeAccount(command: string, configDir: string): Account {
  return { id: 'target', label: 'Target', config_dir: configDir, provider: 'claude', command };
}

export interface FakeRecord {
  argv: string[];
  prompt_length: number;
  prompt_sha256: string;
  env_names: string[];
  cwd: string;
}

export function readLog(log: string): FakeRecord[] {
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

export function makeRepo(branch = 'main'): string {
  const dir = tmp('repo');
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'a.txt'), 'a');
  writeFileSync(join(dir, 'sub', 'keep.txt'), 'k');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

export async function waitUntil(
  cond: () => boolean | Promise<boolean>,
  { timeoutMs = 20000, pollMs = 25, what = 'the condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
