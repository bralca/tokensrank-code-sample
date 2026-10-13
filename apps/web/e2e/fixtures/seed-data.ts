import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

type TestUser = {
  id: string;
  email: string;
  password: string;
};

type TestProfile = {
  id: string;
  user_id: string;
  handle: string;
  display_name: string;
  mode: 'script_verified' | 'self_reported';
};

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[e2e] Missing required environment variable: ${name}`);
  }

  return value;
}

function createServiceClient(schema: string) {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      db: {
        schema,
      },
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

export async function createTestUser(prefix = 'e2e'): Promise<TestUser> {
  const serviceClient = createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
  const password = `Tr-${randomUUID()}!`;
  const email = `${prefix}-${randomUUID()}@example.com`;
  const { data, error } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`[e2e] Failed to create test user: ${error?.message ?? 'missing user'}`);
  }

  return {
    id: data.user.id,
    email,
    password,
  };
}

export async function createTestProfile(
  user: TestUser,
  schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0',
): Promise<TestProfile> {
  const serviceClient = createServiceClient(schema);
  const profile: TestProfile = {
    id: randomUUID(),
    user_id: user.id,
    handle: `e2e_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    display_name: 'E2E Test User',
    mode: 'script_verified',
  };

  const { error } = await serviceClient.from('profiles').insert(profile);

  if (error) {
    throw new Error(`[e2e] Failed to create test profile in ${schema}: ${error.message}`);
  }

  return profile;
}
