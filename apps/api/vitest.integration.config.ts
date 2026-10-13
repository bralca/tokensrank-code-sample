import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'test/integration/**/*.{test,spec}.ts',
      'src/**/*.integration.{test,spec}.ts',
      'src/lib/bearer-auth.test.ts',
      'src/routes/**/__tests__/**/*.test.ts',
    ],
    setupFiles: ['./test/integration/per-worker-setup.ts'],
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
});
