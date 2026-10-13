import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

type ProfileMode = 'script_verified' | 'self_reported' | null;

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;

async function createTrackedKey(scope: 'script' | 'self_reported', label: string) {
  const fixture = await createAccessKeyFixture(scope, label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function getProfileMode(profileId: string): Promise<{ mode: ProfileMode; verified: boolean }> {
  const admin = createSchemaServiceRoleClient();
  const { data, error } = await admin
    .from('profiles')
    .select('mode,verified')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[mode-escalation-wiring] Profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return data as { mode: ProfileMode; verified: boolean };
}

async function setProfileMode(profileId: string, mode: ProfileMode): Promise<void> {
  const admin = createSchemaServiceRoleClient();
  const { error } = await admin
    .from('profiles')
    .update({
      mode,
      verified: mode === 'script_verified',
    })
    .eq('id', profileId);

  if (error) {
    throw new Error(`[mode-escalation-wiring] Profile mode setup failed: ${error.message}`);
  }
}

async function postSessions(input: {
  accessKey: string;
  label: string;
  url: '/api/script/sessions' | '/api/self-reported/sessions';
}) {
  return await app.inject({
    method: 'POST',
    url: input.url,
    headers: {
      authorization: `Bearer ${input.accessKey}`,
      origin: 'http://localhost:3000',
    },
    payload: buildIngestPayload(1, input.label),
  });
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe('QC-6 mode escalation wiring', () => {
  it('creates access-key fixtures as self_reported users', async () => {
    const fixture = await createTrackedKey('script', 'qc6_mode_start');

    await expect(getProfileMode(fixture.profileId)).resolves.toEqual({
      mode: 'self_reported',
      verified: false,
    });
  });

  it('updates a self_reported profile to script_verified on first script ingest', async () => {
    const fixture = await createTrackedKey('script', 'qc6_mode_escalate');
    const response = await postSessions({
      accessKey: fixture.plaintext,
      label: 'qc6-mode-escalate',
      url: '/api/script/sessions',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
    await expect(getProfileMode(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });
  });

  it('does not downgrade a script_verified profile on self-reported ingest', async () => {
    const fixture = await createTrackedKey('self_reported', 'qc6_mode_no_down');

    await setProfileMode(fixture.profileId, 'script_verified');

    const response = await postSessions({
      accessKey: fixture.plaintext,
      label: 'qc6-mode-no-downgrade',
      url: '/api/self-reported/sessions',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
    await expect(getProfileMode(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });
  });
});
