import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { buildServer } from '../../src/server';
import {
  createDisposableAnonClient,
  createServiceRoleClient,
  resolveTestSchema,
} from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const password = 'Correct-horse-battery-staple-74!';
const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;

type TestProfile = {
  accessToken: string;
  profileId: string;
  userId: string;
};

function uniqueSuffix(): string {
  return `${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

async function waitForProfile(userId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await adminClient
      .from('profiles')
      .select('id,user_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data) {
      return data as { id: string; user_id: string };
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  throw new Error(`[onboarding-sse] profile shell was not created for user ${userId}`);
}

async function createAuthenticatedProfile(label: string): Promise<TestProfile> {
  const authAdmin = createServiceRoleClient();
  const anon = createDisposableAnonClient(schema);
  const suffix = uniqueSuffix();
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 12);
  const email = `onboarding-sse-${schema}-${safeLabel}-${suffix}@example.com`;
  const handle = `sse_${safeLabel}_${suffix.replace(/[^a-z0-9_]/g, '_')}`.slice(0, 30);

  const { data: userData, error: createError } = await authAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (createError || !userData.user) {
    throw new Error(`[onboarding-sse] createUser failed: ${createError?.message ?? 'missing user'}`);
  }

  createdUserIds.add(userData.user.id);
  const profile = await waitForProfile(userData.user.id);
  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({
      handle,
      mode: 'script_verified',
      verified: true,
      onboarded_at: null,
    })
    .eq('id', profile.id)
    .select('id')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[onboarding-sse] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
    throw new Error(`[onboarding-sse] sign-in failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: signInData.session.access_token,
    profileId: updatedProfile.id as string,
    userId: userData.user.id,
  };
}

async function seedCompletedIngestionRun(profileId: string) {
  const finishedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const { data, error } = await adminClient
    .from('ingestion_runs')
    .insert({
      profile_id: profileId,
      started_at: startedAt,
      finished_at: finishedAt,
      completed_at: finishedAt,
      status: 'completed',
      ingestion_mode: 'script_verified',
      session_count: 1,
      duplicate_count: 0,
      rejected_count: 0,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`[onboarding-sse] ingestion run seed failed: ${error?.message ?? 'missing row'}`);
  }

  return data as { id: string };
}

function parseSseEvents(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: (.+)$/m)?.[1] ?? 'message';
      const data = chunk.match(/^data: (.+)$/m)?.[1] ?? '{}';

      return {
        event,
        data: JSON.parse(data) as Record<string, unknown>,
      };
    });
}

beforeAll(async () => {
  app = await buildServer({
    logger: false,
  });
  await app.ready();
});

beforeEach(() => {
  app.cache.purgeAll();
});

afterAll(async () => {
  await app?.close();

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe.sequential('GET /api/onboarding/waiting SSE', () => {
  it('requires auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/onboarding/waiting',
    });

    expect(response.statusCode).toBe(401);
  });

  it('sends detected on the first completed ingestion run', async () => {
    const profile = await createAuthenticatedProfile('detected');
    const run = await seedCompletedIngestionRun(profile.profileId);
    const response = await app.inject({
      method: 'GET',
      url: '/api/onboarding/waiting',
      headers: {
        authorization: `Bearer ${profile.accessToken}`,
      },
    });
    const events = parseSseEvents(response.body);

    expect(response.statusCode).toBe(200);
    expect(events.map((event) => event.event)).toContain('detected');
    expect(events.find((event) => event.event === 'detected')?.data.ingestion_run_id).toBe(run.id);
  });

  it('times out after the configured timeout window', async () => {
    const previousTimeout = process.env.ONBOARDING_SSE_TIMEOUT_MS;
    process.env.ONBOARDING_SSE_TIMEOUT_MS = '20';

    try {
      const profile = await createAuthenticatedProfile('timeout');
      const response = await app.inject({
        method: 'GET',
        url: '/api/onboarding/waiting',
        headers: {
          authorization: `Bearer ${profile.accessToken}`,
        },
      });
      const events = parseSseEvents(response.body);

      expect(response.statusCode).toBe(200);
      expect(events.map((event) => event.event)).toContain('timeout');
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.ONBOARDING_SSE_TIMEOUT_MS;
      } else {
        process.env.ONBOARDING_SSE_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it('keeps polling until a later completed ingestion run appears', async () => {
    const previousPoll = process.env.ONBOARDING_SSE_POLL_MS;
    const previousTimeout = process.env.ONBOARDING_SSE_TIMEOUT_MS;
    process.env.ONBOARDING_SSE_POLL_MS = '20';
    process.env.ONBOARDING_SSE_TIMEOUT_MS = '1000';

    try {
      const profile = await createAuthenticatedProfile('late_detect');
      const responsePromise = app.inject({
        method: 'GET',
        url: '/api/onboarding/waiting',
        headers: {
          authorization: `Bearer ${profile.accessToken}`,
        },
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 60);
      });

      const run = await seedCompletedIngestionRun(profile.profileId);
      const response = await responsePromise;
      const events = parseSseEvents(response.body);

      expect(response.statusCode).toBe(200);
      expect(events.find((event) => event.event === 'detected')?.data.ingestion_run_id).toBe(run.id);
    } finally {
      if (previousPoll === undefined) {
        delete process.env.ONBOARDING_SSE_POLL_MS;
      } else {
        process.env.ONBOARDING_SSE_POLL_MS = previousPoll;
      }

      if (previousTimeout === undefined) {
        delete process.env.ONBOARDING_SSE_TIMEOUT_MS;
      } else {
        process.env.ONBOARDING_SSE_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});
