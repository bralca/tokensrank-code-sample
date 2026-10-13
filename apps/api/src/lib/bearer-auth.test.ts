import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from '../../test/integration/ingestion-test-helpers';
import { resolveTestSchema, setupTestSchema } from '../../test/integration/setup';

type BuiltServer = Awaited<ReturnType<typeof import('../server').buildServer>>;
type AccessKeyScope = 'script' | 'self_reported';

const createdUserIds = new Set<string>();

let app: BuiltServer;

async function createKey(scope: AccessKeyScope, label: string) {
  const safeLabel = `${label.replace(/[^a-z0-9_]/g, '_').slice(0, 4)}_${crypto.randomBytes(3).toString('hex')}`;
  const fixture = await createAccessKeyFixture(scope, safeLabel);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function postSessions(
  url: string,
  accessKey: string,
  label: string,
  options: { origin?: string } = { origin: 'http://localhost:3000' },
) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      authorization: `Bearer ${accessKey}`,
    },
    payload: buildIngestPayload(1, label),
  });
}

async function postScriptWithoutAuthorization(label: string) {
  return app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      origin: 'http://localhost:3000',
    },
    payload: buildIngestPayload(1, label),
  });
}

async function revokeAccessKey(accessKeyId: string): Promise<void> {
  const admin = createSchemaServiceRoleClient();
  const { error } = await admin
    .from('access_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', accessKeyId);

  if (error) {
    throw new Error(`[bearer-auth] failed to revoke access key ${accessKeyId}: ${error.message}`);
  }
}

function unknownAccessKey(scope: AccessKeyScope): string {
  return `tr_${scope}_${crypto.randomBytes(24).toString('base64url')}`;
}

async function waitForLastUsedAt(accessKeyId: string): Promise<string> {
  const admin = createSchemaServiceRoleClient();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await admin
      .from('access_keys')
      .select('last_used_at')
      .eq('id', accessKeyId)
      .single();

    if (!error && data?.last_used_at) {
      return data.last_used_at as string;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  throw new Error(`[bearer-auth] last_used_at was not updated for access key ${accessKeyId}`);
}

beforeAll(async () => {
  process.env.SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
  process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS = '1000';

  await setupTestSchema(process.env.SUPABASE_SCHEMA);

  const server = await import('../server');

  app = await server.buildServer({ logger: false });
  app.get(
    '/__test/bearer-auth-context',
    { preHandler: app.requireAccessKey },
    async (request) => ({
      data: {
        accessKeyProfileId: request.accessKey?.profileId,
        authProfileId: (request as typeof request & { auth?: { profileId: string } }).auth?.profileId,
        profileHandle: request.accessKey?.profile?.handle,
        scope: request.accessKey?.scope,
      },
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe.sequential('bearer access-key middleware', () => {
  it('accepts a valid script token on /api/script/sessions and updates last_used_at', async () => {
    const fixture = await createKey('script', 'bearer_valid');
    const response = await postSessions('/api/script/sessions', fixture.plaintext, 'bearer-valid');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
    await expect(waitForLastUsedAt(fixture.accessKeyId)).resolves.toEqual(expect.any(String));
  });

  it('accepts bearer-token ingestion without a browser Origin header', async () => {
    const fixture = await createKey('script', 'bearer_no_origin');
    const response = await postSessions('/api/script/sessions', fixture.plaintext, 'bearer-no-origin', {
      origin: undefined,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
  });

  it('rejects a missing Authorization header with a generic 401', async () => {
    const response = await postScriptWithoutAuthorization('bearer-missing');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects malformed bearer token formats with a generic 401', async () => {
    const response = await postSessions('/api/script/sessions', 'tr_script_short', 'bearer-malformed');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects a valid-looking non-existent token with a generic 401', async () => {
    const response = await postSessions('/api/script/sessions', unknownAccessKey('script'), 'bearer-unknown');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects a revoked token with key_revoked', async () => {
    const fixture = await createKey('script', 'bearer_revoked');
    await revokeAccessKey(fixture.accessKeyId);

    const response = await postSessions('/api/script/sessions', fixture.plaintext, 'bearer-revoked');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'key_revoked',
        message: 'This access key has been revoked',
      },
    });
  });

  it('accepts correct scope keys on both ingestion endpoints', async () => {
    const scriptFixture = await createKey('script', 'bearer_scope_script_ok');
    const selfReportedFixture = await createKey('self_reported', 'bearer_scope_self_ok');

    const scriptResponse = await postSessions(
      '/api/script/sessions',
      scriptFixture.plaintext,
      'bearer-scope-script-ok',
    );
    const selfReportedResponse = await postSessions(
      '/api/self-reported/sessions',
      selfReportedFixture.plaintext,
      'bearer-scope-self-ok',
    );

    expect(scriptResponse.statusCode).toBe(202);
    expect(scriptResponse.json()).toMatchObject({
      accepted: 1,
      rejected: 0,
    });
    expect(selfReportedResponse.statusCode).toBe(202);
    expect(selfReportedResponse.json()).toMatchObject({
      accepted: 1,
      rejected: 0,
    });
  });

  it('rejects script keys on the self-reported endpoint', async () => {
    const fixture = await createKey('script', 'bearer_scope_script_bad');
    const response = await postSessions(
      '/api/self-reported/sessions',
      fixture.plaintext,
      'bearer-script-on-self',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'wrong_key_scope',
        message: 'Access key scope must be self_reported',
      },
    });
  });

  it('rejects self-reported keys on the script endpoint', async () => {
    const fixture = await createKey('self_reported', 'bearer_scope_self_bad');
    const response = await postSessions(
      '/api/script/sessions',
      fixture.plaintext,
      'bearer-self-on-script',
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'wrong_key_scope',
        message: 'Access key scope must be script',
      },
    });
  });

  it('registers requireAccessKey as a decorator and exposes accessKey context to handlers', async () => {
    const fixture = await createKey('script', 'bearer_context');
    const response = await app.inject({
      method: 'GET',
      url: '/__test/bearer-auth-context',
      headers: {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${fixture.plaintext}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        accessKeyProfileId: fixture.profileId,
        authProfileId: fixture.profileId,
        profileHandle: fixture.handle,
        scope: 'script',
      },
    });
  });
});
