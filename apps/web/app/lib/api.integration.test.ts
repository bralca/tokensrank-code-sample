import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

const apiBaseUrl = process.env.API_INTEGRATION_BASE_URL ?? 'http://127.0.0.1:4001';
const origin = process.env.API_INTEGRATION_ORIGIN ?? 'http://localhost:3000';
const password = 'Correct-horse-battery-staple-73!';

type JsonBody = Record<string, unknown>;
type RpcClient = {
  rpc: (
    fn: string,
    args: { schema_name: string },
  ) => PromiseLike<{ error: { message: string } | null }>;
};

function loadRootEnv(): void {
  const envPath = path.resolve(__dirname, '../../../../.env');

  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;

    if (key) {
      process.env[key] = rawValue.replace(/^['"]|['"]$/gu, '');
    }
  }
}

function cookieHeader(response: Response): string {
  const setCookie = response.headers.get('set-cookie');

  if (!setCookie) {
    throw new Error('Expected sign-up response to include Set-Cookie');
  }

  return setCookie
    .split(/,(?=\s*tr_)/u)
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

async function readJson(response: Response): Promise<JsonBody> {
  expect(response.headers.get('content-type')).toContain('application/json');

  return await response.json() as JsonBody;
}

async function apiRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${apiBaseUrl}${pathname}`, {
    ...init,
    headers: {
      Origin: origin,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    redirect: 'manual',
  });
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[api.integration] Missing required env ${name}`);
  }

  return value;
}

function publicServiceClient(): RpcClient {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

function schemaServiceClient(schema: string) {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      db: { schema },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          'Accept-Profile': schema,
          'Content-Profile': schema,
        },
      },
    },
  );
}

async function resetWorkerSchema(schema: string): Promise<void> {
  const service = publicServiceClient();
  const { error } = await service.rpc('reset_test_schema', {
    schema_name: schema,
  });

  if (error) {
    throw new Error(`[api.integration] reset_test_schema failed: ${error.message}`);
  }
}

async function waitForSchemaCache(schema: string): Promise<void> {
  const service = schemaServiceClient(schema);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { error } = await service
      .from('profiles')
      .select('id')
      .limit(1);

    if (!error) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error(`[api.integration] schema cache did not expose ${schema}.profiles`);
}

beforeAll(async () => {
  loadRootEnv();
  process.env.SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';

  await resetWorkerSchema(process.env.SUPABASE_SCHEMA);
  await waitForSchemaCache(process.env.SUPABASE_SCHEMA);

  const health = await fetch(`${apiBaseUrl}/health`);
  expect(health.ok).toBe(true);
});

describe('apiFetch backend integration contract', () => {
  it('signs up, forwards cookies, mutates profile, and reads public API data', async () => {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const email = `api-integration-${id}@tokensrank.ai`;
    const handle = `ai_${id}`.toLowerCase();
    const displayName = `API Integration ${id}`;

    const signUp = await apiRequest('/api/auth/sign-up', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        handle,
      }),
    });
    const cookies = cookieHeader(signUp);
    const signUpBody = await readJson(signUp);

    expect([200, 302]).toContain(signUp.status);
    expect(signUpBody.data).toMatchObject({ handle });

    const me = await apiRequest('/api/me', {
      headers: {
        Cookie: cookies,
      },
    });
    const meBody = await readJson(me);

    expect(me.status).toBe(200);
    expect(meBody.data).toMatchObject({ handle });
    expect(me.headers.get('x-tokensrank-cache')).toBeTruthy();

    const patch = await apiRequest('/api/me/profile', {
      method: 'PATCH',
      headers: {
        Cookie: cookies,
      },
      body: JSON.stringify({
        displayName,
        bio: 'Updated by api.integration.test.ts',
        shareProjects: true,
      }),
    });
    const patchBody = await readJson(patch);

    expect(patch.status).toBe(200);
    expect(patch.headers.get('x-cache-tags')).toBe('profile,leaderboard,me');
    expect(patchBody.data).toMatchObject({ updated: true });

    const profile = await apiRequest(`/api/profile/${handle}?window=all`);
    const profileBody = await readJson(profile);

    expect(profile.status).toBe(200);
    expect(profile.headers.get('x-tokensrank-cache')).toBeTruthy();
    expect(profile.headers.get('cache-control')).toContain('max-age');
    expect(profileBody.identity).toMatchObject({
      handle,
      display_name: displayName,
    });

    const leaderboard = await apiRequest('/api/leaderboard?period=all&scope=all&limit=10&offset=0');
    const leaderboardBody = await readJson(leaderboard);

    expect(leaderboard.status).toBe(200);
    expect(leaderboard.headers.get('x-tokensrank-cache')).toBeTruthy();
    expect(leaderboard.headers.get('cache-control')).toContain('max-age');
    expect(Array.isArray(leaderboardBody.data)).toBe(true);

    const invalid = await apiRequest('/api/me/profile', {
      method: 'PATCH',
      headers: {
        Cookie: cookies,
      },
      body: JSON.stringify({
        displayName: 'x'.repeat(101),
      }),
    });
    const invalidBody = await readJson(invalid);

    expect(invalid.status).toBe(400);
    expect(invalidBody.error).toMatchObject({
      code: 'invalid_request',
      message: 'Request body failed schema validation',
    });
  }, 60_000);
});
