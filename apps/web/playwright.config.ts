import { defineConfig, devices } from '@playwright/test';

const workerIndex = Number(process.env.PLAYWRIGHT_WORKER_INDEX ?? 0);
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000 + workerIndex);
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT ?? 4001 + workerIndex);
const supabaseSchema = process.env.SUPABASE_SCHEMA ?? `tokensrank_test_w${workerIndex % 4}`;
const isSigninTarget = process.argv.some((arg) => arg === 'signin' || arg.includes('signin.spec.ts'));
const hasExplicitTestTarget = process.argv.some((arg) => (
  arg.endsWith('.spec.ts') || arg.includes('e2e/') || arg.includes('regression')
));
const includeRegression = process.argv.some((arg) => (
  arg.includes('regression') || arg.includes('signup-script') || arg.includes('signin')
));
const outcomeSeoRegressionFiles = [
  'regression/seo.spec.ts',
  'regression/sitemap.spec.ts',
  'regression/og-tags.spec.ts',
  'regression/seo-accessibility.spec.ts',
  'regression/visual-regression-seo.spec.ts',
];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 4,
  testMatch: hasExplicitTestTarget ? undefined : outcomeSeoRegressionFiles,
  testIgnore: !hasExplicitTestTarget ? [] : isSigninTarget ? ['**/wiring/**'] : includeRegression ? [] : ['**/regression/**'],
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/fixtures/global-setup.ts',
  globalTeardown: './e2e/fixtures/global-teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    ...(isSigninTarget ? [] : [{
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    }, {
      name: 'firefox',
      grep: /@firefox-deferred/,
      use: { ...devices['Desktop Firefox'] },
    }]),
  ],
  webServer: [
    {
      command: [
        'pnpm',
        'exec',
        'dotenv',
        '-e',
        '../../.env',
        '--',
        'cross-env',
        'NODE_ENV=test',
        'START_FASTIFY=true',
        `PORT=${apiPort}`,
        `ALLOWED_ORIGINS=http://127.0.0.1:${webPort},http://localhost:${webPort}`,
        `SUPABASE_SCHEMA=${supabaseSchema}`,
        'tsx',
        '../api/src/server.ts',
      ].join(' '),
      cwd: __dirname,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
    {
      command: [
        'pnpm',
        'exec',
        'dotenv',
        '-e',
        '../../.env',
        '--',
        'cross-env',
        `NEXT_PUBLIC_API_BASE=http://127.0.0.1:${apiPort}`,
        'next',
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(webPort),
      ].join(' '),
      cwd: __dirname,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
});
