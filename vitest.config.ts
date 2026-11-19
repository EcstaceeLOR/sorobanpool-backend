import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Specs that boot an in-process Postgres can be slow on a loaded machine; fail on real problems, not on load.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    root: './',
    include: ['**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.spec.ts', 'src/generated/**', 'src/dev/**'],
      reporter: ['text', 'json-summary'],
      // Floors for the money-critical modules (#168). `pnpm test:cov` fails when one drops below its floor. These are
      // starting values, deliberately below today's numbers: raise each to just under the figure CI prints for it.
      thresholds: {
        'src/pools/pricing.ts': { lines: 90, functions: 90, statements: 90, branches: 80 },
        'src/relayer/**': { lines: 70, functions: 70, statements: 70, branches: 60 },
        'src/keeper/**': { lines: 70, functions: 70, statements: 70, branches: 60 },
        'src/indexer/projector.ts': { lines: 70, functions: 70, statements: 70, branches: 60 },
      },
    },
  },
});
