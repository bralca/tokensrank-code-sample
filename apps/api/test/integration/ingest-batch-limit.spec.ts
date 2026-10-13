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

async function postScriptSessions(count: number, label: string) {
  return app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${scriptKey}`,
    },
    payload: buildIngestPayload(count, label),
  });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const fixture = await createAccessKeyFixture('script', 'batch');
  scriptKey = fixture.plaintext;
  createdUserIds.add(fixture.userId);
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe('POST /api/script/sessions batch size enforcement', () => {
  it('accepts a batch of exactly 100 sessions', async () => {
    const response = await postScriptSessions(100, 'batch-100');
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({
      accepted: 100,
      deduped: 0,
      rejected: 0,
      rejected_details: [],
    });
    expect(body.ingestion_run_id).toEqual(expect.any(String));
  });

  it.each([101, 200, 201])('rejects a batch of %i sessions before schema parsing', async (count) => {
    const response = await postScriptSessions(count, `batch-${count}`);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: {
        code: 'batch_too_large',
        message: 'Batch size exceeds 100 sessions',
      },
    });
  });
});
