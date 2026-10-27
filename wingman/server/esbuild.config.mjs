import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  banner: {
    js: "import { createRequire as __wmCreateRequire } from 'node:module';\nconst require = __wmCreateRequire(import.meta.url);",
  },
});
