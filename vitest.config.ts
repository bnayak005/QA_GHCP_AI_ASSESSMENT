import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['server/app.ts', 'server/domain.ts', 'src/state.ts', 'shared/contracts.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
