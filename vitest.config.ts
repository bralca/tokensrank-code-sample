import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.{test,spec}.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.next-*/**',
      '**/.worktrees/**',
      '**/.pnpm-store/**',
      '**/e2e/**',
      '**/test/integration/**',
      // These suites create Supabase users and belong to the API integration config.
      '**/src/lib/bearer-auth.test.ts',
      '**/src/routes/**/__tests__/**/*.test.ts',
      '**/*.integration.{test,spec}.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
