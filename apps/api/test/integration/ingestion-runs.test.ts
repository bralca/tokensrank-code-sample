import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IngestRequest, SessionPayload } from '@tokensrank/shared';

import { buildServer } from '../../src/server';
import { resetCacheForTests } from '../../src/services/cache';
import { IngestionService } from '../../src/services/ingestion';
import type { AccessKeyContext } from '../../src/middleware/auth';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

type AccessKeyFixture = Awaited<ReturnType<typeof createAccessKeyFixture>>;

const createdUserIds = new Set<string>();
const originalFraudRateLimitMaxRequests = process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS;
const originalGlobalRateLimitMaxRequests = process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS;

let app: Awaited<ReturnType<typeof buildServer>>;
let admin: ReturnType<typeof createSchemaServiceRoleClient>;

function uniqueLabel(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function clonePayload(payload: ReturnType<typeof buildIngestPayload>): IngestRequest {
  return structuredClone(payload) as IngestRequest;
}

async function createFixture(scope: 'script' | 'self_reported', label: string): Promise<AccessKeyFixture> {
  const fixture = await createAccessKeyFixture(scope, label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function postSessions(url: string, accessKey: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url,
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
    .select([
      'id',
      'profile_id',
      'status',
      'ingestion_mode',
      'started_at',
      'finished_at',
      'completed_at',
      'session_count',
      'duplicate_count',
      'rejected_count',
      'client_json',
      'run_json',
      'rejected_details_json',
    ].join(','))
    .eq('id', ingestionRunId)
    .single();

  if (error || !data) {
    throw new Error(`[ingestion-runs] run lookup failed: ${error?.message ?? 'missing row'}`);
  }

  return data as {
    id: string;
    profile_id: string;
    status: string;
    ingestion_mode: string;
    started_at: string;
    finished_at: string | null;
    completed_at: string | null;
    session_count: number;
    duplicate_count: number;
    rejected_count: number;
    client_json: Record<string, unknown>;
    run_json: Record<string, unknown>;
    rejected_details_json: Array<Record<string, unknown>>;
  };
}

async function getRunsForProfile(profileId: string) {
  const { data, error } = await admin
    .from('ingestion_runs')
    .select('id,status')
    .eq('profile_id', profileId)
    .order('started_at', { ascending: true });

  if (error) {
    throw new Error(`[ingestion-runs] profile run lookup failed: ${error.message}`);
  }

  return data ?? [];
}

async function getAuditEvents(profileId: string) {
  const { data, error } = await admin
    .from('audit_events')
    .select('event_type,severity,payload')
    .eq('profile_id', profileId);

  if (error) {
    throw new Error(`[ingestion-runs] audit lookup failed: ${error.message}`);
  }

  return (data ?? []) as Array<{
    event_type: string;
    severity: string;
    payload: Record<string, unknown>;
  }>;
}

function expectUtcTimestamp(value: string | null): asserts value is string {
  expect(value).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/));
}

function makeAccessContext(fixture: AccessKeyFixture): AccessKeyContext {
  return {
    profileId: fixture.profileId,
    accessKeyId: fixture.accessKeyId,
    keySha256: crypto.createHash('sha256').update(fixture.plaintext).digest('hex'),
    scope: fixture.scope,
    mode: 'self_reported',
    profile: {},
  };
}

beforeAll(async () => {
  process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS = '10';
  process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS = '1000';

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

  if (originalGlobalRateLimitMaxRequests === undefined) {
    delete process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS;
  } else {
    process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS = originalGlobalRateLimitMaxRequests;
  }

  if (originalFraudRateLimitMaxRequests === undefined) {
    delete process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS;
  } else {
    process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS = originalFraudRateLimitMaxRequests;
  }
});

describe.sequential('ingestion_runs lifecycle', () => {
  it('creates a processing row with endpoint-derived mode and lifecycle JSON before finalization', async () => {
    const fixture = await createFixture('script', 'runs_processing');
    const payload = clonePayload(buildIngestPayload(1, uniqueLabel('runs-processing')));
    const service = new IngestionService({ supabaseClient: admin });
    const ingestionRunId = await service.openIngestionRun(
      makeAccessContext(fixture),
      payload,
      'script_verified',
      Date.now(),
    );

    const run = await getRun(ingestionRunId);

    expect(run).toMatchObject({
      id: ingestionRunId,
      profile_id: fixture.profileId,
      status: 'processing',
      ingestion_mode: 'script_verified',
      session_count: 1,
      duplicate_count: 0,
      rejected_count: 0,
    });
    expect(run.client_json).toMatchObject(payload.client);
    expect(run.run_json).toMatchObject({
      accepted_count: 0,
      deduped_count: 0,
      rejected_count: 0,
      total_duration_ms: 0,
    });
    expect(run.rejected_details_json).toEqual([]);
    expectUtcTimestamp(run.started_at);

    service.dispose();
  });

  it('marks script ingestion completed when all sessions are accepted', async () => {
    const fixture = await createFixture('script', 'runs_completed');
    const payload = clonePayload(buildIngestPayload(2, uniqueLabel('runs-completed')));
    const response = await postSessions('/api/script/sessions', fixture.plaintext, payload);
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({
      ingestion_run_id: expect.any(String),
      accepted: 2,
      deduped: 0,
      rejected: 0,
    });

    const run = await getRun(body.ingestion_run_id);
    expect(run.status).toBe('completed');
    expect(run.ingestion_mode).toBe('script_verified');
    expect(run.completed_at).not.toBeNull();
    expectUtcTimestamp(run.completed_at);
    expect(new Date(run.completed_at).getTime()).toBeGreaterThanOrEqual(new Date(run.started_at).getTime());
    expect(run.run_json).toMatchObject({
      accepted_count: 2,
      deduped_count: 0,
      rejected_count: 0,
      total_duration_ms: expect.any(Number),
    });
    expect(run.rejected_details_json).toEqual([]);
  });

  it('marks self-reported ingestion partial when accepted and rejected sessions are mixed', async () => {
    const fixture = await createFixture('self_reported', 'runs_partial');
    const payload = clonePayload(buildIngestPayload(2, uniqueLabel('runs-partial')));
    const futureSession = payload.sessions[1] as SessionPayload;
    payload.sessions[1] = {
      ...futureSession,
      first_event_at: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
      last_event_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    const response = await postSessions('/api/self-reported/sessions', fixture.plaintext, payload);
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({
      accepted: 1,
      rejected: 1,
    });

    const run = await getRun(body.ingestion_run_id);
    expect(run.status).toBe('partial');
    expect(run.ingestion_mode).toBe('self_reported');
    expect(run.run_json).toMatchObject({
      accepted_count: 1,
      rejected_count: 1,
    });
    expect(run.rejected_details_json).toEqual([
      expect.objectContaining({
        session_id: payload.sessions[1].session_id,
        reason_code: 'future_timestamp',
      }),
    ]);
  });

  it('marks batch validation failures failed and preserves the row', async () => {
    const fixture = await createFixture('script', 'runs_failed');
    const response = await postSessions('/api/script/sessions', fixture.plaintext, {
      client: { version: '1.0.0' },
      run: { run_id: uniqueLabel('runs-invalid') },
      sessions: [{ invalid: true }],
    });

    expect(response.statusCode).toBe(400);

    const runs = await getRunsForProfile(fixture.profileId);
    expect(runs).toHaveLength(1);

    const run = await getRun(runs[0].id);
    expect(run.status).toBe('failed');
    expect(run.completed_at).not.toBeNull();
    expect(run.run_json).toMatchObject({
      accepted_count: 0,
      deduped_count: 0,
      rejected_count: 1,
      total_duration_ms: expect.any(Number),
    });
    expect(run.rejected_details_json).toEqual([
      expect.objectContaining({
        session_id: '__batch__',
        reason_code: 'schema_invalid',
      }),
    ]);
  });

  it('keeps ingestion run rows as an audit trail across repeated requests', async () => {
    const fixture = await createFixture('self_reported', 'runs_audit');
    const firstPayload = clonePayload(buildIngestPayload(1, uniqueLabel('runs-audit-a')));
    const secondPayload = clonePayload(buildIngestPayload(1, uniqueLabel('runs-audit-b')));

    const first = await postSessions('/api/self-reported/sessions', fixture.plaintext, firstPayload);
    const second = await postSessions('/api/self-reported/sessions', fixture.plaintext, secondPayload);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);

    const runs = await getRunsForProfile(fixture.profileId);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.id)).size).toBe(2);
    expect(runs.every((run) => run.status === 'completed')).toBe(true);
  });

  it('writes an ingestion.completed audit event with final counts', async () => {
    const fixture = await createFixture('script', 'runs_audit_event');
    const payload = clonePayload(buildIngestPayload(1, uniqueLabel('runs-audit-event')));
    const response = await postSessions('/api/script/sessions', fixture.plaintext, payload);

    expect(response.statusCode).toBe(202);

    const events = await getAuditEvents(fixture.profileId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'ingestion.completed',
        severity: 'info',
        payload: expect.objectContaining({
          accepted: 1,
          deduped: 0,
          rejected: 0,
        }),
      }),
    ]));
  });

  it('creates isolated run ids for concurrent requests', async () => {
    const fixture = await createFixture('self_reported', 'runs_concurrent');
    const firstPayload = clonePayload(buildIngestPayload(1, uniqueLabel('runs-concurrent-a')));
    const secondPayload = clonePayload(buildIngestPayload(1, uniqueLabel('runs-concurrent-b')));
    const [first, second] = await Promise.all([
      postSessions('/api/self-reported/sessions', fixture.plaintext, firstPayload),
      postSessions('/api/self-reported/sessions', fixture.plaintext, secondPayload),
    ]);
    const firstBody = first.json();
    const secondBody = second.json();

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(firstBody.ingestion_run_id).not.toBe(secondBody.ingestion_run_id);
    await expect(getRun(firstBody.ingestion_run_id)).resolves.toMatchObject({
      status: 'completed',
      ingestion_mode: 'self_reported',
    });
    await expect(getRun(secondBody.ingestion_run_id)).resolves.toMatchObject({
      status: 'completed',
      ingestion_mode: 'self_reported',
    });
  });

  it('marks deduped-only retries completed while preserving the run row', async () => {
    const fixture = await createFixture('script', 'runs_deduped');
    const payload = clonePayload(buildIngestPayload(1, uniqueLabel('runs-deduped')));
    const first = await postSessions('/api/script/sessions', fixture.plaintext, payload);
    const second = await postSessions('/api/script/sessions', fixture.plaintext, payload);
    const secondBody = second.json();

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(secondBody).toMatchObject({
      accepted: 0,
      deduped: 1,
      rejected: 0,
    });

    const run = await getRun(secondBody.ingestion_run_id);
    expect(run).toMatchObject({
      status: 'completed',
      duplicate_count: 1,
      rejected_count: 0,
    });
    expect(run.run_json).toMatchObject({
      accepted_count: 0,
      deduped_count: 1,
      rejected_count: 0,
    });
  });

  it('marks empty batches failed with no sessions persisted', async () => {
    const fixture = await createFixture('self_reported', 'runs_empty');
    const payload = clonePayload(buildIngestPayload(0, uniqueLabel('runs-empty')));
    const response = await postSessions('/api/self-reported/sessions', fixture.plaintext, payload);
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({
      accepted: 0,
      deduped: 0,
      rejected: 0,
    });

    const run = await getRun(body.ingestion_run_id);
    expect(run).toMatchObject({
      status: 'failed',
      session_count: 0,
      duplicate_count: 0,
      rejected_count: 0,
    });
  });

  it('marks rate-limited requests failed and records retry metadata', async () => {
    const fixture = await createFixture('script', 'runs_rate');
    const payload = clonePayload(buildIngestPayload(1, uniqueLabel('runs-rate')));
    const responses = [];

    for (let index = 0; index < 11; index += 1) {
      responses.push(await postSessions('/api/script/sessions', fixture.plaintext, payload));
    }

    const limited = responses[10];
    expect(responses.slice(0, 10).every((response) => response.statusCode === 202)).toBe(true);
    expect(limited?.statusCode).toBe(429);
    expect(limited?.headers['retry-after']).toBeTruthy();

    const runs = await getRunsForProfile(fixture.profileId);
    expect(runs).toHaveLength(11);
    expect(runs.at(-1)).toMatchObject({
      status: 'failed',
    });
  });
});
