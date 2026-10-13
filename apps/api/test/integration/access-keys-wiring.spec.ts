import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;

type AccessKeyFixture = Awaited<ReturnType<typeof createAccessKeyFixture>>;

async function createTrackedKey(scope: 'script' | 'self_reported', label: string): Promise<AccessKeyFixture> {
  const fixture = await createAccessKeyFixture(scope, label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function postSessions(input: {
  accessKey?: string;
  label: string;
  url: '/api/script/sessions' | '/api/self-reported/sessions';
}) {
  return await app.inject({
    method: 'POST',
    url: input.url,
    headers: {
      origin: 'http://localhost:3000',
      ...(input.accessKey ? { authorization: `Bearer ${input.accessKey}` } : {}),
    },
    payload: buildIngestPayload(1, input.label),
  });
}

async function revokeAccessKey(accessKeyId: string): Promise<void> {
  const admin = createSchemaServiceRoleClient();
  const { error } = await admin
    .from('access_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', accessKeyId);

  if (error) {
    throw new Error(`[access-keys-wiring] access key revoke failed: ${error.message}`);
  }
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe('QC-6 access key scope and authorization wiring', () => {
  it('accepts a script key at the script ingestion endpoint', async () => {
    const fixture = await createTrackedKey('script', 'qc6_script_ok');
    const response = await postSessions({
      accessKey: fixture.plaintext,
      label: 'qc6-script-ok',
      url: '/api/script/sessions',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
  });

  it('accepts a self-reported key at the self-reported ingestion endpoint', async () => {
    const fixture = await createTrackedKey('self_reported', 'qc6_self_ok');
    const response = await postSessions({
      accessKey: fixture.plaintext,
      label: 'qc6-self-ok',
      url: '/api/self-reported/sessions',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
  });

  it('rejects a script key at the self-reported endpoint', async () => {
    const fixture = await createTrackedKey('script', 'qc6_script_wrong');
    const response = await postSessions({
      accessKey: fixture.plaintext,
      label: 'qc6-script-on-self',
      url: '/api/self-reported/sessions',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'wrong_key_scope',
        message: 'Access key scope must be self_reported',
      },
    });
  });

  it('rejects a self-reported key at the script endpoint', async () => {
    const fixture = await createTrackedKey('self_reported', 'qc6_self_wrong');
    const response = await postSessions({
      accessKey: fixture.plaintext,
      label: 'qc6-self-on-script',
      url: '/api/script/sessions',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'wrong_key_scope',
        message: 'Access key scope must be script',
      },
    });
  });

  it('rejects a revoked key before ingestion runs', async () => {
    const fixture = await createTrackedKey('script', 'qc6_revoked');
    await revokeAccessKey(fixture.accessKeyId);

    const response = await postSessions({
      accessKey: fixture.plaintext,
      label: 'qc6-revoked',
      url: '/api/script/sessions',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'key_revoked',
        message: 'This access key has been revoked',
      },
    });
  });

  it('rejects missing bearer auth before ingestion runs', async () => {
    const response = await postSessions({
      label: 'qc6-missing-auth',
      url: '/api/script/sessions',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });
});
