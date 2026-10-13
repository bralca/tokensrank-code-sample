import { defineConfig } from 'vitest/config';
import { createHmac } from 'node:crypto';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role: 'service_role', exp: 4102444800 })}`;
const signature = createHmac('sha256', 'tokensrank-isolated-test-secret-at-least-32-characters').update(unsigned).digest('base64url');
export default defineConfig({ test: {
  include: ['test/local-publish/**/*.integration.test.ts'],
  setupFiles: ['test/local-publish/setup.ts'],
  env: {
    SUPABASE_URL: process.env.TOKENSRANK_TEST_REST_URL ?? 'http://127.0.0.1:55440',
    SUPABASE_ANON_KEY: `${unsigned}.${signature}`,
    SUPABASE_SERVICE_ROLE_KEY: `${unsigned}.${signature}`,
    SUPABASE_SCHEMA: 'public', TOKENSRANK_PUBLISH_WORKER: 'false',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3200',
    ALLOWED_ORIGINS: 'http://localhost:3200',
  },
  fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000,
} });
