import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../clients/supabase';

import { checkHandleAvailability } from './handle';

const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
const createdUserIds = new Set<string>();

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[handle-test] Missing required environment variable: ${name}`);
  }

  return value;
}

function createAuthAdminClient() {
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

function uniqueHandle(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 10);
  const unique = Math.random().toString(36).slice(2, 10);

  return `${safeLabel}_${unique}`.slice(0, 30);
}

async function waitForProfile(userId: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await adminClient
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (!error && data) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`[handle-test] Profile shell was not created in ${schema}`);
}

async function createProfileWithHandle(handle: string): Promise<string> {
  const authAdmin = createAuthAdminClient();
  const email = `handle-${schema}-${handle}-${Date.now()}@example.com`;

  const { data: userData, error: userError } = await authAdmin.auth.admin.createUser({
    email,
    password: 'correct-horse-battery-staple',
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[handle-test] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  createdUserIds.add(userData.user.id);
  await waitForProfile(userData.user.id);

  const { error: profileError } = await adminClient
    .from('profiles')
    .update({
      handle,
      mode: 'self_reported',
      verified: false,
    })
    .eq('id', userData.user.id);

  if (profileError) {
    throw new Error(`[handle-test] profile update failed: ${profileError.message}`);
  }

  return userData.user.id;
}

beforeAll(async () => {
  await createProfileWithHandle('taken_handle');
  await createProfileWithHandle('user_123');
});

afterAll(async () => {
  const authAdmin = createAuthAdminClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe('checkHandleAvailability', () => {
  it('returns available for a valid unclaimed handle', async () => {
    await expect(checkHandleAvailability(adminClient, uniqueHandle('available'))).resolves.toEqual({
      available: true,
    });
  });

  it('returns taken for a claimed handle from the real profiles table', async () => {
    await expect(checkHandleAvailability(adminClient, 'taken_handle')).resolves.toEqual({
      available: false,
      reason: 'handle already taken',
    });
  });

  it('uses exact ILIKE matching for handles with underscores', async () => {
    await expect(checkHandleAvailability(adminClient, 'user_123')).resolves.toEqual({
      available: false,
      reason: 'handle already taken',
    });

    await expect(checkHandleAvailability(adminClient, 'usera123')).resolves.toEqual({
      available: true,
    });
  });

  it('normalizes whitespace before querying availability', async () => {
    await expect(checkHandleAvailability(adminClient, '  taken_handle  ')).resolves.toEqual({
      available: false,
      reason: 'handle already taken',
    });
  });

  it('rejects reserved handles before querying the database', async () => {
    await expect(checkHandleAvailability(adminClient, 'admin')).resolves.toEqual({
      available: false,
      reason: 'that handle\'s reserved',
    });
  });

  it.each([
    ['ab', 'between 3 and 30 characters'],
    ['Uppercase', 'must be lowercase'],
    ['user.name', 'letters, numbers, dash, and underscore only'],
  ])('rejects invalid handle "%s" before querying the database', async (handle, reason) => {
    await expect(checkHandleAvailability(adminClient, handle)).resolves.toEqual({
      available: false,
      reason,
    });
  });
});
