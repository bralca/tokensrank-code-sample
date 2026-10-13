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
let scriptKey: string;
let selfReportedKey: string;
let revokedKey: string;

async function postScriptSessions(accessKey: string, label: string) {
  return app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${accessKey}`,
    },
    payload: buildIngestPayload(1, label),
  });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const scriptFixture = await createAccessKeyFixture('script', 'ct_valid');
  const selfReportedFixture = await createAccessKeyFixture('self_reported', 'ct_scope');
  const revokedFixture = await createAccessKeyFixture('script', 'ct_revoked');
  const admin = createSchemaServiceRoleClient();

  const { error: revokeError } = await admin
    .from('access_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', revokedFixture.accessKeyId);

  if (revokeError) {
    throw new Error(`[access-key-validation] revoke failed: ${revokeError.message}`);
  }

  scriptKey = scriptFixture.plaintext;
  selfReportedKey = selfReportedFixture.plaintext;
  revokedKey = revokedFixture.plaintext;

  createdUserIds.add(scriptFixture.userId);
  createdUserIds.add(selfReportedFixture.userId);
  createdUserIds.add(revokedFixture.userId);
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe('access key token validation', () => {
  it('accepts a valid script key', async () => {
    const response = await postScriptSessions(scriptKey, 'ct-valid');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
  });

  it('rejects an invalid key with a generic 401', async () => {
    const invalidKey = `tr_script_${'a'.repeat(32)}`;
    const response = await postScriptSessions(invalidKey, 'ct-invalid');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects a wrong-length key with a generic 401', async () => {
    const response = await postScriptSessions('tr_script_short', 'ct-short');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects a revoked key after timing-safe hash comparison', async () => {
    const response = await postScriptSessions(revokedKey, 'ct-revoked');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'key_revoked',
        message: 'This access key has been revoked',
      },
    });
  });

  it('rejects a valid key with the wrong scope as forbidden', async () => {
    const response = await postScriptSessions(selfReportedKey, 'ct-wrong-scope');

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'wrong_key_scope',
        message: 'Access key scope must be script',
      },
    });
  });
});
