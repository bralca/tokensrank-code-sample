import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const CACHE_HEADER = 'x-tokensrank-cache';

function apiBaseUrl(): string {
  return `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
}

function webOrigin(): string {
  return `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;
}

function apiUrl(path: string): string {
  return `${apiBaseUrl()}${path}`;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[deployment-smoke] Missing required environment variable: ${name}`);
  }

  return value;
}

function loadRootEnv(): void {
  const envPath = resolve(process.cwd(), '../../.env');

  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;

    if (key && process.env[key] === undefined) {
      process.env[key] = (rawValue ?? '').replace(/^['"]|['"]$/g, '');
    }
  }
}

loadRootEnv();

test.describe('deployment readiness smoke', () => {
  test('healthz, leaderboard cache, and admin cache purge are wired', async ({ page }) => {
    const healthResponse = await page.request.get(apiUrl('/healthz'));
    const healthBody = await healthResponse.json();

    expect(healthResponse.status()).toBe(200);
    expect(healthBody).toMatchObject({
      status: 'ok',
      service: 'api',
      dependencies: {
        supabase: { status: 'ok' },
        advisory_lock: { status: 'ok' },
        cache: { status: 'ok' },
      },
    });
    expect(healthResponse.headers()['cache-control']).toBe('no-store');

    const firstLeaderboard = await page.request.get(apiUrl('/api/leaderboard?limit=1'));
    expect(firstLeaderboard.status()).toBe(200);
    expect(firstLeaderboard.headers()[CACHE_HEADER]).toBe('MISS');

    const secondLeaderboard = await page.request.get(apiUrl('/api/leaderboard?limit=1'));
    expect(secondLeaderboard.status()).toBe(200);
    expect(secondLeaderboard.headers()[CACHE_HEADER]).toBe('HIT');

    const rejectedPurge = await page.request.post(apiUrl('/api/admin/cache/purge'), {
      headers: {
        Authorization: 'Bearer invalid-admin-token',
        Origin: webOrigin(),
        'Content-Type': 'application/json',
      },
      data: { all: true },
    });

    expect(rejectedPurge.status()).toBe(401);

    const purgeResponse = await page.request.post(apiUrl('/api/admin/cache/purge'), {
      headers: {
        Authorization: `Bearer ${readRequiredEnv('ADMIN_PURGE_TOKEN')}`,
        Origin: webOrigin(),
        'Content-Type': 'application/json',
      },
      data: { all: true },
    });
    const purgeBody = await purgeResponse.json();

    expect(purgeResponse.status()).toBe(200);
    expect(purgeBody.data.purged_count).toBeGreaterThanOrEqual(1);

    const postPurgeLeaderboard = await page.request.get(apiUrl('/api/leaderboard?limit=1'));
    expect(postPurgeLeaderboard.status()).toBe(200);
    expect(postPurgeLeaderboard.headers()[CACHE_HEADER]).toBe('MISS');
  });
});
