import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

// The sources only read `version`; bundling the whole package.json would make
// dist stale on every dependency bump (every dependabot PR failed the freshness check).
const versionOnly = {
  name: 'package-version-only',
  setup(b) {
    b.onLoad({ filter: /[\\/]package\.json$/ }, async (args) => {
      const { version } = JSON.parse(await readFile(args.path, 'utf8'));
      return { contents: JSON.stringify({ version }), loader: 'json' };
    });
  },
};

await build({
  entryPoints: ['src/index.ts'],
  outfile: process.env.WINGMAN_BUNDLE_OUT ?? 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  plugins: [versionOnly],
  banner: {
    js: "import { createRequire as __wmCreateRequire } from 'node:module';\nconst require = __wmCreateRequire(import.meta.url);",
  },
});
