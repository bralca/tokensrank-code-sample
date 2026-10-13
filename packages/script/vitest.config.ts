import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**', 'test/**/*.bats', 'test/**/*.ps1'],
    passWithNoTests: true,
  },
});
