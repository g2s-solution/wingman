import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

describe('committed bundle', () => {
  it('equals a fresh build', () => {
    const out = mkdtempSync(join(tmpdir(), 'wm-bundle-'));
    try {
      execFileSync(
        join(root, 'node_modules/.bin/esbuild'),
        [
          'src/index.ts',
          '--bundle',
          '--platform=node',
          '--format=esm',
          '--target=node22',
          '--legal-comments=none',
          `--outfile=${join(out, 'index.js')}`,
          `--banner:js=${readBanner()}`,
        ],
        { cwd: root, stdio: 'ignore' },
      );
      expect(readFileSync(join(out, 'index.js'), 'utf8')).toBe(
        readFileSync(join(root, 'dist/index.js'), 'utf8'),
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

function readBanner(): string {
  const cfg = readFileSync(join(root, 'esbuild.config.mjs'), 'utf8');
  const m = /js: ("(?:[^"\\]|\\.)*")/.exec(cfg);
  if (!m?.[1]) throw new Error('banner not found in esbuild.config.mjs');
  return JSON.parse(m[1]) as string;
}
