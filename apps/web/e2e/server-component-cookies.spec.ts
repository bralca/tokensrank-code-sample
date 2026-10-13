import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIResponse, type Page } from '@playwright/test';

const testPassword = 'Correct-horse-battery-staple-73!';
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;

type SeededUser = {
  displayName: string;
  email: string;
  handle: string;
};

function loadRootEnv(): void {
  const envPath = path.resolve(__dirname, '../../../.env');

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

loadRootEnv();

function schemaName(): string {
  return process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
}

function serviceClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[server-cookies-e2e] Missing Supabase service env');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    db: { schema: schemaName() },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        'Accept-Profile': schemaName(),
        'Content-Profile': schemaName(),
      },
    },
  });
}

async function waitForProfileShell(userId: string): Promise<{ id: string }> {
  const service = serviceClient();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await service
      .from('profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle<{ id: string }>();

    if (!error && data) {
      return data;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  throw new Error(`[server-cookies-e2e] profile shell was not created for user ${userId}`);
}

async function createSeededUser(): Promise<SeededUser> {
  const service = serviceClient();
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const email = `server-cookies-${id}@example.com`;
  const handle = `sc_${id}`.toLowerCase();
  const displayName = `Server Cookies ${id}`;

  const { data: userData, error: userError } = await service.auth.admin.createUser({
    email,
    password: testPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schemaName(),
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[server-cookies-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  const profileShell = await waitForProfileShell(userData.user.id);
  const { error: profileError } = await service
    .from('profiles')
    .update({
      handle,
      display_name: displayName,
      avatar_url: null,
      bio: 'Profile loaded by a server component through forwarded cookies.',
      x_handle: handle.slice(0, 15),
      mode: 'script_verified',
      verified: true,
      share_projects: false,
    })
    .eq('id', profileShell.id);

  if (profileError) {
    throw new Error(`[server-cookies-e2e] profile update failed: ${profileError.message}`);
  }

  return {
    displayName,
    email,
    handle,
  };
}

async function bridgeAuthCookies(page: Page, response: APIResponse): Promise<void> {
  const setCookieHeaders = (await response.headersArray())
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);

  expect(setCookieHeaders.length).toBeGreaterThanOrEqual(2);

  await page.context().addCookies(setCookieHeaders.map((header) => {
    const [pair = ''] = header.split(';');
    const separator = pair.indexOf('=');

    return {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    };
  }));
}

test('server component forwards sign-in cookies to GET /api/me', async ({ page }) => {
  const user = await createSeededUser();

  const signInResponse = await page.request.post('/api/auth/sign-in', {
    headers: {
      Origin: webOrigin,
    },
    data: {
      email: user.email,
      password: testPassword,
    },
  });

  expect(signInResponse.status()).toBe(200);
  await bridgeAuthCookies(page, signInResponse);
  await page.goto('/me', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/me/);
  await expect(page.getByRole('heading', { name: 'Your TokensRank profile' })).toBeVisible();
  await expect(page.getByTestId('me-display-name')).toHaveText(user.displayName);
});

test('server component redirects unauthenticated /me requests to sign-in', async ({ page }) => {
  await page.goto('/me');

  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await expect(page.getByRole('heading', { name: 'Sign in to TokensRank' })).toBeVisible();
});
