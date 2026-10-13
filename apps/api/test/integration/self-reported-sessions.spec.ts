import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IngestRequest } from '@tokensrank/shared';

import { buildServer } from '../../src/server';
import { resetCacheForTests } from '../../src/services/cache';
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

async function createSelfReportedFixture(label: string): Promise<AccessKeyFixture> {
  const fixture = await createAccessKeyFixture('self_reported', label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function createScriptFixture(label: string): Promise<AccessKeyFixture> {
  const fixture = await createAccessKeyFixture('script', label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function postSelfReported(accessKey: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/self-reported/sessions',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${accessKey}`,
      'content-type': 'application/json',
    },
    payload: body,
  });
}

async function getRun(ingestionRunId: string) {
  const { data, error } = await admin
    .from('ingestion_runs')
    .select('id, status, ingestion_mode, session_count, duplicate_count, rejected_count, error_summary, finished_at')
    .eq('id', ingestionRunId)
    .single();

  if (error || !data) {
    throw new Error(`[task47] ingestion run lookup failed: ${error?.message ?? 'missing run'}`);
  }

  return data as {
    id: string;
    status: string;
    ingestion_mode: string;
    session_count: number;
    duplicate_count: number;
    rejected_count: number;
    error_summary: { rejected_details?: unknown } | null;
    finished_at: string | null;
  };
}

async function getRunsForProfile(profileId: string) {
  const { data, error } = await admin
    .from('ingestion_runs')
    .select('id,status,rejected_count')
    .eq('profile_id', profileId);

  if (error) {
    throw new Error(`[task47] ingestion runs lookup failed: ${error.message}`);
  }

  return data ?? [];
}

async function getSessions(profileId: string, sessionIds: string[]) {
  const { data, error } = await admin
    .from('sessions')
    .select('session_id, ingestion_mode')
    .eq('profile_id', profileId)
    .in('session_id', sessionIds);

  if (error) {
    throw new Error(`[task47] sessions lookup failed: ${error.message}`);
  }

  return (data ?? []) as Array<{ session_id: string; ingestion_mode: string }>;
}

async function getDailyAggregates(profileId: string) {
  const { data, error } = await admin
    .from('daily_aggregates')
    .select('profile_id, total_tokens, total_sessions')
    .eq('profile_id', profileId);

  if (error) {
    throw new Error(`[task47] daily aggregates lookup failed: ${error.message}`);
  }

  return (data ?? []) as Array<{ profile_id: string; total_tokens: number; total_sessions: number }>;
}

async function getAuditEvents(profileId: string) {
  const { data, error } = await admin
    .from('audit_events')
    .select('event_type, severity, payload')
    .eq('profile_id', profileId);

  if (error) {
    throw new Error(`[task47] audit lookup failed: ${error.message}`);
  }

  return (data ?? []) as Array<{
    event_type: string;
    severity: string;
    payload: Record<string, unknown>;
  }>;
}

async function setProfileMode(profileId: string, mode: 'script_verified' | 'self_reported' | null) {
  const { error } = await admin
    .from('profiles')
    .update({
      mode,
      verified: mode === 'script_verified',
    })
    .eq('id', profileId);

  if (error) {
    throw new Error(`[task47] profile mode update failed: ${error.message}`);
  }
}

async function getProfile(profileId: string) {
  const { data, error } = await admin
    .from('profiles')
    .select('mode, verified')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[task47] profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return data as { mode: string | null; verified: boolean };
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

describe.sequential('Task 47 POST /api/self-reported/sessions ingestion endpoint', () => {
  it('accepts a valid payload, persists self-reported sessions, completes the run, and updates daily aggregates', async () => {
    const fixture = await createSelfReportedFixture('task47_happy');
    const payload = clonePayload(buildIngestPayload(2, uniqueLabel('task47-happy')));

    const response = await postSelfReported(fixture.plaintext, payload);
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(response.headers['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body).toMatchObject({
      ingestion_run_id: expect.any(String),
      ingestionRunId: expect.any(String),
      mode: 'self_reported',
      accepted: 2,
      deduped: 0,
      rejected: 0,
      rejected_details: [],
      rejectedDetails: [],
      counts: {
        accepted: 2,
        deduped: 0,
        rejected: 0,
      },
      data: {
        ingestion_run_id: expect.any(String),
        mode: 'self_reported',
        accepted: 2,
        deduped: 0,
        rejected: 0,
        rejected_details: [],
        run_duration_ms: expect.any(Number),
      },
      run_duration_ms: expect.any(Number),
      runDurationMs: expect.any(Number),
    });
    expect(body.ingestionRunId).toBe(body.ingestion_run_id);

    await expect(getSessions(fixture.profileId, sessionIds(payload))).resolves.toHaveLength(2);
    await expect(getRun(body.ingestion_run_id)).resolves.toMatchObject({
      id: body.ingestion_run_id,
      status: 'completed',
      ingestion_mode: 'self_reported',
      session_count: 2,
      duplicate_count: 0,
      rejected_count: 0,
      finished_at: expect.any(String),
    });

    const aggregates = await getDailyAggregates(fixture.profileId);
    expect(aggregates.reduce((sum, row) => sum + Number(row.total_sessions), 0)).toBe(2);
  });

  it('rejects a script-scoped key with wrong_key_scope and inserts no sessions', async () => {
    const fixture = await createScriptFixture('task47_scope');
    const payload = clonePayload(buildIngestPayload(1, uniqueLabel('task47-scope')));

    const response = await postSelfReported(fixture.plaintext, payload);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'wrong_key_scope',
        message: 'Access key scope must be self_reported',
      },
    });
    await expect(getSessions(fixture.profileId, sessionIds(payload))).resolves.toHaveLength(0);
  });

  it('rejects a 101-session batch with batch_too_large and marks the run failed', async () => {
    const fixture = await createSelfReportedFixture('task47_batch');
    const payload = buildIngestPayload(101, uniqueLabel('task47-oversized'));

    const response = await postSelfReported(fixture.plaintext, payload);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: {
        code: 'batch_too_large',
        message: 'Batch size exceeds 100 sessions',
      },
    });
    await expect(getRunsForProfile(fixture.profileId)).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        rejected_count: 101,
      }),
    ]);
  });

  it('rejects an over-bounds session, inserts no session row, and marks the run failed', async () => {
    const fixture = await createSelfReportedFixture('task47_bounds');
    const payload = clonePayload(buildIngestPayload(1, uniqueLabel('task47-bounds')));
    payload.sessions[0] = {
      ...payload.sessions[0],
      input_tokens: 200_000_000, // exceeds MAX_TOTAL_TOKENS -> bounds_violation
    };

    const response = await postSelfReported(fixture.plaintext, payload);
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({
      accepted: 0,
      deduped: 0,
      rejected: 1,
      rejected_details: [
        {
          session_id: payload.sessions[0].session_id,
          reason_code: 'bounds_violation',
        },
      ],
    });
    await expect(getSessions(fixture.profileId, sessionIds(payload))).resolves.toHaveLength(0);
    await expect(getRun(body.ingestion_run_id)).resolves.toMatchObject({
      status: 'failed',
      ingestion_mode: 'self_reported',
      rejected_count: 1,
    });
  });

  it('dedupes a repeated session without inserting another row or logging a rejection', async () => {
    const fixture = await createSelfReportedFixture('task47_dedup');
    const payload = clonePayload(buildIngestPayload(1, uniqueLabel('task47-dedup')));

    const first = await postSelfReported(fixture.plaintext, payload);
    const second = await postSelfReported(fixture.plaintext, payload);

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 0,
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({
      accepted: 0,
      deduped: 1,
      rejected: 0,
      rejected_details: [],
    });

    await expect(getSessions(fixture.profileId, sessionIds(payload))).resolves.toHaveLength(1);
    const rejectionEvents = (await getAuditEvents(fixture.profileId))
      .filter((event) => event.event_type === 'fraud.rejected');
    expect(rejectionEvents).toHaveLength(0);
  });

  it('accepts repeated self-reported requests under the global burst ceiling', async () => {
    const fixture = await createSelfReportedFixture('task47_repeat');
    const responses = [];

    for (let index = 0; index < 11; index += 1) {
      const payload = clonePayload(buildIngestPayload(1, uniqueLabel(`task47-repeat-${index}`)));
      responses.push(await postSelfReported(fixture.plaintext, payload));
    }

    expect(responses.every((response) => response.statusCode === 202)).toBe(true);
    expect(responses.map((response) => response.json())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accepted: 1,
          rejected: 0,
        }),
      ]),
    );
  });

  it('does not escalate a NULL profile mode or write a mode escalation audit event', async () => {
    const fixture = await createSelfReportedFixture('task47_no_mode');
    await setProfileMode(fixture.profileId, null);
    const payload = clonePayload(buildIngestPayload(1, uniqueLabel('task47-no-mode')));

    const response = await postSelfReported(fixture.plaintext, payload);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 1,
      rejected: 0,
      mode: 'self_reported',
    });
    await expect(getProfile(fixture.profileId)).resolves.toEqual({
      mode: null,
      verified: false,
    });

    const escalationEvents = (await getAuditEvents(fixture.profileId))
      .filter((event) => event.event_type === 'profile.mode_escalation');
    expect(escalationEvents).toHaveLength(0);
  });
});
