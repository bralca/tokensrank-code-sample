import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
let scriptProfileId: string;
let scriptKey: string;
let selfReportedProfileId: string;
let selfReportedKey: string;

function readApiSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

async function postSessions(url: string, accessKey: string, label: string, extraPayload = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${accessKey}`,
    },
    payload: {
      ...buildIngestPayload(1, label),
      ...extraPayload,
    },
  });
}

async function getProfileMode(profileId: string) {
  const admin = createSchemaServiceRoleClient();
  const { data, error } = await admin
    .from('profiles')
    .select('mode')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[mode-endpoint-test] profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return (data as { mode: string | null }).mode;
}

async function getSessionMode(profileId: string, sessionId: string) {
  const admin = createSchemaServiceRoleClient();
  const { data, error } = await admin
    .from('sessions')
    .select('ingestion_mode')
    .eq('profile_id', profileId)
    .eq('session_id', sessionId)
    .single();

  if (error || !data) {
    throw new Error(`[mode-endpoint-test] session lookup failed: ${error?.message ?? 'missing session'}`);
  }

  return (data as { ingestion_mode: string }).ingestion_mode;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const scriptFixture = await createAccessKeyFixture('script', 'modea');
  const selfFixture = await createAccessKeyFixture('self_reported', 'modeb');

  scriptProfileId = scriptFixture.profileId;
  scriptKey = scriptFixture.plaintext;
  selfReportedProfileId = selfFixture.profileId;
  selfReportedKey = selfFixture.plaintext;

  createdUserIds.add(scriptFixture.userId);
  createdUserIds.add(selfFixture.userId);
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe('mode service endpoint integration', () => {
  it('documents where mode helpers are wired into endpoint flow', () => {
    const scriptRoute = readApiSource('src/routes/script-sessions.ts');
    const selfReportedRoute = readApiSource('src/routes/self-reported-sessions.ts');
    const ingestionService = readApiSource('src/services/ingestion.ts');

    expect(scriptRoute).toContain("determineIngestionMode('script')");
    expect(selfReportedRoute).toContain("determineIngestionMode('self-reported')");
    expect(ingestionService).toContain('validatePayloadDoesNotIncludeIngestionMode(body)');
    expect(ingestionService).toContain('await this.insertSessions(');
    expect(ingestionService).toContain('await this.checkModeEscalation(auth, scope, insertedCount)');
    expect(ingestionService).toContain('await escalateProfileMode(');
  });

  it('stamps script endpoint sessions as script_verified and escalates the profile after insert', async () => {
    const label = 'mode-endpoint-script';
    const response = await postSessions('/api/script/sessions', scriptKey, label);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 1, rejected: 0 });
    await expect(getSessionMode(scriptProfileId, `${label}-session-0`)).resolves.toBe('script_verified');
    await expect(getProfileMode(scriptProfileId)).resolves.toBe('script_verified');
  });

  it('stamps self-reported endpoint sessions as self_reported without profile escalation', async () => {
    const label = 'mode-endpoint-self';
    const response = await postSessions('/api/self-reported/sessions', selfReportedKey, label);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 1, rejected: 0 });
    await expect(getSessionMode(selfReportedProfileId, `${label}-session-0`)).resolves.toBe('self_reported');
    await expect(getProfileMode(selfReportedProfileId)).resolves.toBe('self_reported');
  });

  it('rejects payloads that attempt to supply ingestion_mode', async () => {
    const response = await postSessions('/api/script/sessions', scriptKey, 'mode-endpoint-spoof', {
      ingestion_mode: 'self_reported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'schema_invalid',
      },
    });
  });
});
