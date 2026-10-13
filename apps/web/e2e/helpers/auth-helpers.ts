import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, type BrowserContext, type Page, type Response as PlaywrightResponse } from '@playwright/test';

export type SeededPasswordResetUser = {
  email: string;
  handle: string;
  originalPassword: string;
  profileId: string;
  userId: string;
};

export const ORIGINAL_PASSWORD = 'Tr-original-reset-58!';
export const NEW_PASSWORD = 'Tr-new-reset-59!';

const USER_EMAIL_DOMAIN = 'example.com';

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[password-reset-e2e] Missing required environment variable: ${name}`);
  }

  return value;
}

export function loadRootEnv(): void {
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

export function testSchema(): string {
  return `tokensrank_test_w${Number(process.env.PLAYWRIGHT_WORKER_INDEX ?? 0) % 4}`;
}

export function apiBaseUrl(): string {
  return `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
}

export function webBaseUrl(): string {
  return `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;
}

export function createServiceRoleClient(schema?: string): SupabaseClient<any, any, any> {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      ...(schema ? { db: { schema } } : {}),
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      ...(schema
        ? {
          global: {
            headers: {
              'Accept-Profile': schema,
              'Content-Profile': schema,
            },
          },
        }
        : {}),
    },
  );
}

function uniqueToken(label: string): string {
  return `${label.replace(/[^a-z0-9]/g, '').slice(0, 10)}${randomUUID().replace(/-/g, '').slice(0, 12)}`.toLowerCase();
}

async function waitForProfile(userId: string, schema = testSchema()): Promise<void> {
  const admin = createServiceRoleClient(schema);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (!error && data) {
      return;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 200);
    });
  }

  throw new Error(`[password-reset-e2e] profile shell was not created for ${userId}`);
}

export async function seedPasswordResetUser(label = 'reset'): Promise<SeededPasswordResetUser> {
  loadRootEnv();
  const authAdmin = createServiceRoleClient();
  const schemaAdmin = createServiceRoleClient(testSchema());
  const token = uniqueToken(label);
  const email = `${token}-${randomUUID()}@${USER_EMAIL_DOMAIN}`;
  const handle = `pr_${token}`.slice(0, 30);

  const { data: userData, error: userError } = await authAdmin.auth.admin.createUser({
    email,
    password: ORIGINAL_PASSWORD,
    email_confirm: true,
    user_metadata: {
      test_schema: testSchema(),
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[password-reset-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  await waitForProfile(userData.user.id);

  const { data: profile, error: profileError } = await schemaAdmin
    .from('profiles')
    .update({
      handle,
      display_name: 'E2E Password Reset User',
      mode: 'script_verified',
      verified: true,
      onboarded_at: new Date().toISOString(),
    })
    .eq('id', userData.user.id)
    .select('id')
    .single();

  if (profileError || !profile) {
    throw new Error(`[password-reset-e2e] profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  return {
    email,
    handle,
    originalPassword: ORIGINAL_PASSWORD,
    profileId: profile.id as string,
    userId: userData.user.id,
  };
}

export async function deleteAuthUsers(userIds: Iterable<string>): Promise<void> {
  const authAdmin = createServiceRoleClient();

  for (const userId of Array.from(userIds)) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
}

export function parseSetCookieHeader(header: string): {
  httpOnly: boolean;
  maxAge: number | null;
  name: string;
  path: string;
  sameSite: string | null;
  secure: boolean;
  value: string;
} {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  const lowerAttributes = attributes.map((attribute) => attribute.toLowerCase());
  const maxAgeAttribute = attributes.find((attribute) => attribute.toLowerCase().startsWith('max-age='));
  const pathAttribute = attributes.find((attribute) => attribute.toLowerCase().startsWith('path='));
  const sameSiteAttribute = attributes.find((attribute) => attribute.toLowerCase().startsWith('samesite='));

  return {
    httpOnly: lowerAttributes.includes('httponly'),
    maxAge: maxAgeAttribute ? Number.parseInt(maxAgeAttribute.slice('max-age='.length), 10) : null,
    name: pair.slice(0, separator),
    path: pathAttribute ? pathAttribute.slice('path='.length) : '/',
    sameSite: sameSiteAttribute ? sameSiteAttribute.slice('samesite='.length) : null,
    secure: lowerAttributes.includes('secure'),
    value: pair.slice(separator + 1),
  };
}

export async function bridgeSetCookieHeaders(context: BrowserContext, headersArray: Array<{ name: string; value: string }>): Promise<string[]> {
  const setCookieHeaders = headersArray
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);

  expect(setCookieHeaders.length).toBeGreaterThanOrEqual(2);

  await context.addCookies(setCookieHeaders.map((header) => {
    const parsed = parseSetCookieHeader(header);

    return {
      name: parsed.name,
      value: decodeURIComponent(parsed.value),
      domain: '127.0.0.1',
      path: parsed.path,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    };
  }));

  return setCookieHeaders;
}

export async function installCookieBridge(page: Page, endpoint: string): Promise<() => Promise<string[]>> {
  const capturedSetCookieHeaders: string[] = [];

  await page.route(`**${endpoint}`, async (route) => {
    const response = await route.fetch();
    const headersArray = await response.headersArray();
    const responseHeaders = Object.fromEntries(
      headersArray
        .filter((header) => header.name.toLowerCase() !== 'set-cookie')
        .map((header) => [header.name, header.value]),
    );
    const setCookieHeaders = await bridgeSetCookieHeaders(page.context(), headersArray);

    capturedSetCookieHeaders.push(...setCookieHeaders);
    await route.fulfill({
      body: await response.body(),
      headers: responseHeaders,
      status: response.status(),
    });
  }, { times: 1 });

  return async () => capturedSetCookieHeaders;
}

export async function signInViaUi(page: Page, email: string, password: string): Promise<PlaywrightResponse> {
  await page.goto('/auth/sign-in', { waitUntil: 'load' });
  await page.getByTestId('auth-field-email').fill(email);
  await page.getByTestId('auth-field-password').fill(password);

  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/auth/sign-in'));
  await installCookieBridge(page, '/api/auth/sign-in');
  await page.getByTestId('auth-submit').click();
  const response = await responsePromise;

  if (response.status() === 200) {
    await page.waitForURL('**/me', { timeout: 10_000, waitUntil: 'commit' });
  }

  return response;
}

export async function signOutViaUi(page: Page): Promise<PlaywrightResponse> {
  const responsePromise = page.waitForResponse((response) => (
    response.url().includes('/api/auth/sign-out') && response.request().method() === 'POST'
  ));

  await page.context().clearCookies();
  await page.getByTestId('sign-out-button').click();

  return await responsePromise;
}

export async function generateRecoveryToken(email: string): Promise<string> {
  const authAdmin = createServiceRoleClient();
  const { data, error } = await authAdmin.auth.admin.generateLink({
    type: 'recovery',
    email,
  });

  if (error || !data.properties?.hashed_token) {
    throw new Error(`[password-reset-e2e] generateLink failed: ${error?.message ?? 'missing token'}`);
  }

  return data.properties.hashed_token;
}

export async function readAuditEvents(eventType: string, profileId?: string | null): Promise<Array<Record<string, unknown>>> {
  let query = createServiceRoleClient(testSchema())
    .from('audit_events')
    .select('event_type,severity,profile_id,payload,created_at')
    .eq('event_type', eventType)
    .order('created_at', { ascending: false })
    .limit(50);

  if (profileId !== undefined) {
    query = profileId === null ? query.is('profile_id', null) : query.eq('profile_id', profileId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`[password-reset-e2e] audit lookup failed: ${error.message}`);
  }

  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function expectAuditEventEventually(eventType: string, profileId?: string | null): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const events = await readAuditEvents(eventType, profileId);

    if (events.length > 0) {
      return;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 200);
    });
  }

  throw new Error(`[password-reset-e2e] missing audit event ${eventType}`);
}

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
