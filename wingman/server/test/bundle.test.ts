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
      execFileSync(process.execPath, ['esbuild.config.mjs'], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, WINGMAN_BUNDLE_OUT: join(out, 'index.js') },
      });
      expect(readFileSync(join(out, 'index.js'), 'utf8')).toBe(
        readFileSync(join(root, 'dist/index.js'), 'utf8'),
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
