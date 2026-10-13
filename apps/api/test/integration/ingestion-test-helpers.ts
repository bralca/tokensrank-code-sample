import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { createServiceRoleClient, resolveTestSchema } from './setup';

type AccessKeyScope = 'script' | 'self_reported';

const testPassword = 'correct-horse-battery-staple';

function getCurrentSchema(): string {
  return process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
}

function isSchemaCacheMiss(message: string): boolean {
  return message.includes('schema cache') || message.includes('Could not find the table');
}

async function waitForSchemaCache(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[ingestion-test] Missing required environment variable: ${name}`);
  }

  return value;
}

export function createSchemaServiceRoleClient() {
  const schema = getCurrentSchema();

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

async function waitForProfile(profileId: string): Promise<void> {
  const admin = createSchemaServiceRoleClient();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('id', profileId)
      .maybeSingle();

    if (!error && data) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const { error } = await admin
    .from('profiles')
    .upsert({
      id: profileId,
      user_id: profileId,
      handle: null,
      mode: null,
      verified: false,
    }, { onConflict: 'user_id' });

  if (error) {
    throw new Error(`[ingestion-test] Profile fallback insert failed: ${error.message}`);
  }
}

export async function createAccessKeyFixture(scope: AccessKeyScope, label: string) {
  const authAdmin = createServiceRoleClient();
  const schemaAdmin = createSchemaServiceRoleClient();
  const schema = getCurrentSchema();
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 12);
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const email = `ingest-${schema}-${safeLabel}-${unique}@example.com`;
  const handle = `ingest_${safeLabel}_${unique}`.slice(0, 30);
  const plaintext = `tr_${scope}_${crypto.randomBytes(24).toString('base64url')}`;
  const keySha256 = crypto.createHash('sha256').update(plaintext).digest('hex');

  const { data: userData, error: userError } = await authAdmin.auth.admin.createUser({
    email,
    password: testPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[ingestion-test] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  await waitForProfile(userData.user.id);

  let profile: { id: string } | null = null;
  let profileErrorMessage = 'missing profile';

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await schemaAdmin
      .from('profiles')
      .update({
        handle,
        mode: 'self_reported',
        verified: false,
      })
      .eq('id', userData.user.id)
      .select('id')
      .single();

    if (!error && data) {
      profile = data as { id: string };
      break;
    }

    profileErrorMessage = error?.message ?? 'missing profile';

    if (!isSchemaCacheMiss(profileErrorMessage)) {
      break;
    }

    await waitForSchemaCache();
  }

  if (!profile) {
    throw new Error(`[ingestion-test] profile update failed: ${profileErrorMessage}`);
  }

  let accessKey: { id: string } | null = null;
  let accessKeyErrorMessage = 'missing key';

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await schemaAdmin
      .from('access_keys')
      .insert({
        profile_id: profile.id,
        key_sha256: keySha256,
        key_prefix: plaintext.slice(0, 11),
        scope,
      })
      .select('id')
      .single();

    if (!error && data) {
      accessKey = data as { id: string };
      break;
    }

    accessKeyErrorMessage = error?.message ?? 'missing key';

    if (!isSchemaCacheMiss(accessKeyErrorMessage)) {
      break;
    }

    await waitForSchemaCache();
  }

  if (!accessKey) {
    throw new Error(`[ingestion-test] access key insert failed: ${accessKeyErrorMessage}`);
  }

  return {
    accessKeyId: accessKey.id as string,
    handle,
    plaintext,
    profileId: profile.id as string,
    scope,
    userId: userData.user.id,
  };
}

export async function deleteAuthUsers(userIds: Iterable<string>) {
  const authAdmin = createServiceRoleClient();

  for (const userId of userIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
}

export function buildIngestPayload(count: number, label: string) {
  const safeLabel = label.replace(/[^a-z0-9_-]/g, '-');

  return {
    client: {
      version: '1.0.0',
      install_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: `run-${safeLabel}-${count}`,
      started_at: '2026-04-27T10:00:00.000Z',
      finished_at: '2026-04-27T10:10:00.000Z',
    },
    sessions: Array.from({ length: count }, (_, index) => ({
      session_id: `${safeLabel}-session-${index}`,
      model: 'claude-3-5-sonnet-20241022',
      source: 'claude',
      first_event_at: '2026-04-27T10:00:00.000Z',
      last_event_at: '2026-04-27T10:05:00.000Z',
      input_tokens: 12000 + index,
      output_tokens: 3200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      turns: 2,
      file_sha256: crypto.createHash('sha256').update(`${safeLabel}-${index}`).digest('hex'),
    })),
  };
}
