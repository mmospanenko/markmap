import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against workspace sources, not stale builds.
    alias: [
      {
        find: /^@markmap\/([^/]+)$/,
        replacement: fileURLToPath(new URL('./packages/$1/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'packages/model/src/**/*.ts',
        'packages/edit/src/**/*.ts',
        'packages/edit-dom/src/**/*.ts',
        'packages/parse/src/to-tree.ts',
      ],
      exclude: ['**/*.test.ts'],
      thresholds: {
        lines: 98,
        statements: 95,
        functions: 100,
        branches: 89,
      },
    },
  },
});
