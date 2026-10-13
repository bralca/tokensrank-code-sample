import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;
let scriptKey: string;
let selfReportedKey: string;

async function postSessions(url: string, accessKey: string, label: string) {
  return app.inject({
    method: 'POST',
    url,
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

  const scriptFixture = await createAccessKeyFixture('script', 'scopea');
  const selfReportedFixture = await createAccessKeyFixture('self_reported', 'scopeb');

  scriptKey = scriptFixture.plaintext;
  selfReportedKey = selfReportedFixture.plaintext;

  createdUserIds.add(scriptFixture.userId);
  createdUserIds.add(selfReportedFixture.userId);
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe('ingestion access key scope enforcement', () => {
  it('accepts a script-scoped key on the script endpoint', async () => {
    const response = await postSessions('/api/script/sessions', scriptKey, 'script-ok');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
  });

  it('accepts a self-reported key on the self-reported endpoint', async () => {
    const response = await postSessions('/api/self-reported/sessions', selfReportedKey, 'self-ok');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
  });

  it('rejects a self-reported key on the script endpoint', async () => {
    const response = await postSessions('/api/script/sessions', selfReportedKey, 'self-on-script');

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'wrong_key_scope',
        message: 'Access key scope must be script',
      },
    });
  });

  it('rejects a script key on the self-reported endpoint', async () => {
    const response = await postSessions('/api/self-reported/sessions', scriptKey, 'script-on-self');

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'wrong_key_scope',
        message: 'Access key scope must be self_reported',
      },
    });
  });
});
