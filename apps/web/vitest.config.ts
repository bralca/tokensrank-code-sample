import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const react = (await import('@vitejs/plugin-react')).default;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'app'),
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      env: {
        NEXT_PUBLIC_API_BASE: 'http://localhost:3001',
      },
      include: ['**/*.{test,spec}.{ts,tsx}'],
      exclude: [
        '**/node_modules/**',
        '**/.next/**',
        '**/dist/**',
        'e2e/**',
        '**/*.e2e.{test,spec}.{ts,tsx}',
      ],
      passWithNoTests: true,
    },
  };
});
