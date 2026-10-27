import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Thin process entries: they only run inside the bundled subprocess the server tests spawn.
      exclude: ['src/index.ts', 'src/supervisor-main.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
