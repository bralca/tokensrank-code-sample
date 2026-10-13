import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestRequest, SessionPayload } from '@tokensrank/shared';

import { buildServer } from '../../src/server';
import { getCacheVersion, resetCacheForTests } from '../../src/services/cache';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

type AccessKeyFixture = Awaited<ReturnType<typeof createAccessKeyFixture>>;

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;
let admin: ReturnType<typeof createSchemaServiceRoleClient>;

function uniqueLabel(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function clonePayload(payload: ReturnType<typeof buildIngestPayload>): IngestRequest {
  return structuredClone(payload) as IngestRequest;
}

async function createScriptFixture(label: string): Promise<AccessKeyFixture> {
  const fixture = await createAccessKeyFixture('script', label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function postScript(accessKey: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${accessKey}`,
    },
    payload: body,
  });
}

async function getProfile(profileId: string) {
  const { data, error } = await admin
    .from('profiles')
    .select('mode, verified')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[task46] profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return data as { mode: string | null; verified: boolean };
}

async function getSessions(profileId: string, sessionIds: string[]) {
  const { data, error } = await admin
    .from('sessions')
    .select('session_id, ingestion_mode')
    .eq('profile_id', profileId)
    .in('session_id', sessionIds);

  if (error) {
    throw new Error(`[task46] sessions lookup failed: ${error.message}`);
  }

  return data ?? [];
}

async function getRun(ingestionRunId: string) {
  const { data, error } = await admin
    .from('ingestion_runs')
    .select('id, status, started_at, finished_at, session_count, duplicate_count, rejected_count, error_summary')
    .eq('id', ingestionRunId)
    .single();

  if (error || !data) {
    throw new Error(`[task46] ingestion run lookup failed: ${error?.message ?? 'missing run'}`);
  }

  return data as {
    id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    session_count: number;
    duplicate_count: number;
    rejected_count: number;
    error_summary: unknown;
  };
}

async function getAuditEvents(profileId: string) {
  const { data, error } = await admin
    .from('audit_events')
    .select('event_type, severity, payload')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`[task46] audit lookup failed: ${error.message}`);
  }

  return (data ?? []) as Array<{
    event_type: string;
    severity: string;
    payload: Record<string, unknown>;
  }>;
}

function sessionIds(payload: IngestRequest): string[] {
  return payload.sessions.map((session) => session.session_id);
}

beforeAll(async () => {
  admin = createSchemaServiceRoleClient();
  app = await buildServer();
  await app.ready();
});

beforeEach(() => {
  resetCacheForTests();
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe.sequential('Task 46 POST /api/script/sessions ingestion endpoint', () => {
  it('accepts a valid 10-row Mode B batch, returns a run id, and escalates the profile to script_verified', async () => {
    const fixture = await createScriptFixture('task46_happy');
    const payload = clonePayload(buildIngestPayload(10, uniqueLabel('task46-happy')));

    const response = await postScript(fixture.plaintext, payload);
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({
      ingestion_run_id: expect.any(String),
      accepted: 10,
      deduped: 0,
      rejected: 0,
      rejected_details: [],
    });
    await expect(getProfile(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });
    await expect(getSessions(fixture.profileId, sessionIds(payload))).resolves.toHaveLength(10);
  });

  it('deduplicates a conflicting tuple and accepts a later fully-new batch', async () => {
    const fixture = await createScriptFixture('task46_dedup');
    const duplicatePayload = clonePayload(buildIngestPayload(2, uniqueLabel('task46-dedup')));
    duplicatePayload.sessions[1] = {
      ...duplicatePayload.sessions[0],
    } as SessionPayload;

    const first = await postScript(fixture.plaintext, duplicatePayload);
    const secondPayload = clonePayload(buildIngestPayload(3, uniqueLabel('task46-new')));
    const second = await postScript(fixture.plaintext, secondPayload);

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      accepted: 1,
      deduped: 1,
      rejected: 0,
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({
      accepted: 3,
      deduped: 0,
      rejected: 0,
    });

    const rows = await getSessions(fixture.profileId, [
      ...sessionIds(duplicatePayload),
      ...sessionIds(secondPayload),
    ]);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.ingestion_mode === 'script_verified')).toBe(true);
  });

  it('enforces strict schema validation and batch size before session persistence', async () => {
    const schemaFixture = await createScriptFixture('task46_schema');
    const schemaResponse = await postScript(schemaFixture.plaintext, {
      client: { version: '1.0.0' },
      run: { run_id: uniqueLabel('task46-invalid') },
      sessions: [],
    });

    expect(schemaResponse.statusCode).toBe(400);
    expect(schemaResponse.json()).toMatchObject({
      error: {
        code: 'schema_invalid',
      },
    });
    await expect(getSessions(schemaFixture.profileId, ['missing-session'])).resolves.toEqual([]);

    const batchFixture = await createScriptFixture('task46_batch');
    const oversizedResponse = await postScript(
      batchFixture.plaintext,
      buildIngestPayload(101, uniqueLabel('task46-oversized')),
    );

    expect(oversizedResponse.statusCode).toBe(413);
    expect(oversizedResponse.json()).toEqual({
      error: {
        code: 'batch_too_large',
        message: 'Batch size exceeds 100 sessions',
      },
    });
  });

  it('bumps cache version for every successful new session batch and does not repeat mode escalation', async () => {
    const fixture = await createScriptFixture('task46_cache');
    const firstPayload = clonePayload(buildIngestPayload(1, uniqueLabel('task46-cache-a')));
    const secondPayload = clonePayload(buildIngestPayload(1, uniqueLabel('task46-cache-b')));

    expect(getCacheVersion()).toBe(0);

    const first = await postScript(fixture.plaintext, firstPayload);
    expect(first.statusCode).toBe(202);
    expect(getCacheVersion()).toBe(1);

    const second = await postScript(fixture.plaintext, secondPayload);
    expect(second.statusCode).toBe(202);
    expect(getCacheVersion()).toBe(2);

    await expect(getProfile(fixture.profileId)).resolves.toMatchObject({
      mode: 'script_verified',
    });

    const escalationEvents = (await getAuditEvents(fixture.profileId))
      .filter((event) => event.event_type === 'profile.mode_escalation');
    expect(escalationEvents).toHaveLength(1);
  });
});
