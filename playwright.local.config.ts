import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'local-smoke.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://localhost:31770',
    channel: process.env.TOKENSRANK_BROWSER_CHANNEL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx apps/local-api/test/browser-server.ts',
      url: 'http://127.0.0.1:31771/local/profile',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @tokensrank/web exec next dev --port 31770',
      url: 'http://localhost:31770/local/profile',
      reuseExistingServer: false,
      timeout: 90_000,
      env: {
        NEXT_PUBLIC_API_BASE: 'http://localhost:31771',
        NEXT_PUBLIC_SITE_URL: 'http://localhost:31770',
        NEXT_PUBLIC_APP_MODE: 'local',
        TOKENSRANK_WEB_DIST_DIR: '.next-local-smoke',
      },
    },
  ],
});
