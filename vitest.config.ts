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
      // Floors for the money-critical modules (#168). `pnpm test:cov` fails when one drops below its floor. Each sits
      // just under the coverage measured in CI when it was set (recorded in CONTRIBUTING.md); raise, never lower.
      thresholds: {
        'src/pools/pricing.ts': { statements: 98, branches: 85, functions: 98, lines: 98 },
        'src/relayer/**': { statements: 95, branches: 90, functions: 85, lines: 98 },
        'src/keeper/**': { statements: 98, branches: 95, functions: 65, lines: 98 },
        'src/indexer/projector.ts': { statements: 84, branches: 75, functions: 75, lines: 85 },
      },
    },
  },
});
