import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IngestRequestSchema, type IngestRequest, type SessionPayload } from '@tokensrank/shared';

import { buildServer } from '../../src/server';
import { resetCacheForTests } from '../../src/services/cache';
import {
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';
import { resolveTestSchema, setupTestSchema } from './setup';

type AccessKeyFixture = Awaited<ReturnType<typeof createAccessKeyFixture>>;
type ProfileMode = 'script_verified' | 'self_reported' | null;

type ProfileRow = {
  mode: ProfileMode;
  verified: boolean;
};

type SessionRow = {
  session_id: string;
  ingestion_mode: string;
  total_tokens: number | string;
};

type IngestionRunRow = {
  id: string;
  status: string;
  session_count: number;
  duplicate_count: number;
  rejected_count: number;
  rejected_details_json: Array<Record<string, unknown>>;
  run_json: Record<string, unknown>;
};

type DailyAggregateRow = {
  date: string;
  source: string;
  model: string;
  total_tokens: number | string;
  total_sessions: number;
};

type AuditEventRow = {
  event_type: string;
  severity: string;
  payload: Record<string, unknown>;
};

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;
let admin: ReturnType<typeof createSchemaServiceRoleClient>;

function sha(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function uniqueLabel(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function totalTokens(session: SessionPayload): number {
  return session.input_tokens
    + session.output_tokens
    + session.cache_read_input_tokens
    + session.cache_creation_input_tokens
    + session.cached_input_tokens
    + session.reasoning_output_tokens;
}

function buildSession(label: string, index = 0, overrides: Partial<SessionPayload> = {}): SessionPayload {
  const baseMs = Date.now() - (6 * 60 * 60 * 1000) + (index * 10 * 60 * 1000);

  return {
    session_id: `${label}-session-${index}`,
    model: 'claude-3-5-sonnet-20241022',
    source: 'claude',
    first_event_at: iso(baseMs),
    last_event_at: iso(baseMs + (6 * 60 * 1000)),
    input_tokens: 10_000 + index,
    output_tokens: 2_000 + index,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 125,
    cached_input_tokens: 50,
    reasoning_output_tokens: 25,
    turns: 3,
    file_sha256: sha(`${label}-${index}`),
    ...overrides,
  };
}

function buildSessions(label: string, count: number): SessionPayload[] {
  return Array.from({ length: count }, (_, index) => buildSession(label, index));
}

function buildPayload(label: string, sessions: SessionPayload[]): IngestRequest {
  const firstEventTimes = sessions.map((session) => new Date(session.first_event_at).getTime());
  const lastEventTimes = sessions.map((session) => new Date(session.last_event_at).getTime());

  return IngestRequestSchema.parse({
    client: {
      version: '1.0.0',
      install_id: crypto.randomUUID(),
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: `mode-dedup-${label}-${crypto.randomUUID()}`,
      started_at: iso(Math.min(...firstEventTimes)),
      finished_at: iso(Math.max(...lastEventTimes)),
    },
    sessions,
  });
}

async function createScriptFixture(label: string): Promise<AccessKeyFixture> {
  const fixture = await createAccessKeyFixture('script', label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function postScriptSessions(plaintext: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${plaintext}`,
      'content-type': 'application/json',
    },
    payload: body,
  });
}

async function setProfileMode(profileId: string, mode: ProfileMode): Promise<void> {
  const { error } = await admin
    .from('profiles')
    .update({
      mode,
      verified: mode === 'script_verified',
    })
    .eq('id', profileId);

  if (error) {
    throw new Error(`[mode-and-dedup] profile mode setup failed: ${error.message}`);
  }
}

async function getProfile(profileId: string): Promise<ProfileRow> {
  const { data, error } = await admin
    .from('profiles')
    .select('mode, verified')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[mode-and-dedup] profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return data as ProfileRow;
}

async function getSessions(profileId: string, sessionIds?: string[]): Promise<SessionRow[]> {
  let query = admin
    .from('sessions')
    .select('session_id, ingestion_mode, total_tokens')
    .eq('profile_id', profileId)
    .order('session_id', { ascending: true });

  if (sessionIds && sessionIds.length > 0) {
    query = query.in('session_id', sessionIds);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`[mode-and-dedup] sessions lookup failed: ${error.message}`);
  }

  return (data ?? []) as SessionRow[];
}

async function getIngestionRun(ingestionRunId: string): Promise<IngestionRunRow> {
  const { data, error } = await admin
    .from('ingestion_runs')
    .select('id, status, session_count, duplicate_count, rejected_count, rejected_details_json, run_json')
    .eq('id', ingestionRunId)
    .single();

  if (error || !data) {
    throw new Error(`[mode-and-dedup] ingestion run lookup failed: ${error?.message ?? 'missing run'}`);
  }

  return data as IngestionRunRow;
}

async function getDailyAggregates(profileId: string): Promise<DailyAggregateRow[]> {
  const { data, error } = await admin
    .from('daily_aggregates')
    .select('date, source, model, total_tokens, total_sessions')
    .eq('profile_id', profileId)
    .order('date', { ascending: true });

  if (error) {
    throw new Error(`[mode-and-dedup] daily aggregate lookup failed: ${error.message}`);
  }

  return (data ?? []) as DailyAggregateRow[];
}

async function getAuditEvents(profileId: string, eventType?: string): Promise<AuditEventRow[]> {
  let query = admin
    .from('audit_events')
    .select('event_type, severity, payload')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: true });

  if (eventType) {
    query = query.eq('event_type', eventType);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`[mode-and-dedup] audit lookup failed: ${error.message}`);
  }

  return (data ?? []) as AuditEventRow[];
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  process.env.SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
  await setupTestSchema(process.env.SUPABASE_SCHEMA);
  admin = createSchemaServiceRoleClient();
  resetCacheForTests();
});

afterEach(async () => {
  await deleteAuthUsers(createdUserIds);
  createdUserIds.clear();
});

afterAll(async () => {
  await app?.close();
});

describe.sequential('Task 89 mode escalation integration', () => {
  it('escalates a Mode B profile after an 8-session script batch', async () => {
    const fixture = await createScriptFixture('task89_escalate');
    const sessions = buildSessions(uniqueLabel('task89-escalate'), 8);
    const request = buildPayload('first-script-batch', sessions);
    const response = await postScriptSessions(fixture.plaintext, request);
    const body = response.json();

    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({
      ingestion_run_id: expect.any(String),
      mode: 'script_verified',
      accepted: 8,
      deduped: 0,
      rejected: 0,
      rejected_details: [],
    });

    await expect(getProfile(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });

    const rows = await getSessions(fixture.profileId, sessions.map((session) => session.session_id));
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.ingestion_mode === 'script_verified')).toBe(true);
    expect(rows.reduce((sum, row) => sum + Number(row.total_tokens), 0))
      .toBe(sessions.reduce((sum, session) => sum + totalTokens(session), 0));

    await expect(getIngestionRun(body.ingestion_run_id)).resolves.toMatchObject({
      id: body.ingestion_run_id,
      status: 'completed',
      session_count: 8,
      duplicate_count: 0,
      rejected_count: 0,
      rejected_details_json: [],
    });

    const aggregates = await getDailyAggregates(fixture.profileId);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toMatchObject({
      date: sessions[0]?.last_event_at.slice(0, 10),
      source: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      total_sessions: 8,
    });
    expect(Number(aggregates[0]?.total_tokens))
      .toBe(sessions.reduce((sum, session) => sum + totalTokens(session), 0));
  });

  it('keeps mode escalation idempotent across later valid script batches', async () => {
    const fixture = await createScriptFixture('task89_idempotent');
    const firstSessions = buildSessions(uniqueLabel('task89-idempotent-first'), 2);
    const secondSessions = buildSessions(uniqueLabel('task89-idempotent-second'), 3);
    const first = await postScriptSessions(
      fixture.plaintext,
      buildPayload('idempotent-first', firstSessions),
    );
    const second = await postScriptSessions(
      fixture.plaintext,
      buildPayload('idempotent-second', secondSessions),
    );

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      accepted: 2,
      deduped: 0,
      rejected: 0,
    });
    expect(second.json()).toMatchObject({
      accepted: 3,
      deduped: 0,
      rejected: 0,
    });
    await expect(getProfile(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });
    await expect(getSessions(fixture.profileId)).resolves.toHaveLength(5);

    const modeEvents = await getAuditEvents(fixture.profileId, 'profile.mode_escalation');
    expect(modeEvents).toEqual([
      expect.objectContaining({
        severity: 'info',
        payload: {
          previous_mode: 'self_reported',
          next_mode: 'script_verified',
        },
      }),
    ]);
  });
});

describe.sequential('Task 89 dedup integration', () => {
  it('silently dedupes an identical 8-session replay without new session rows', async () => {
    const fixture = await createScriptFixture('task89_dedup');
    const sessions = buildSessions(uniqueLabel('task89-dedup'), 8);
    const request = buildPayload('dedup-replay', sessions);
    const first = await postScriptSessions(fixture.plaintext, request);
    const second = await postScriptSessions(fixture.plaintext, request);
    const secondBody = second.json();

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      accepted: 8,
      deduped: 0,
      rejected: 0,
      rejected_details: [],
    });
    expect(second.statusCode).toBe(202);
    expect(secondBody).toMatchObject({
      ingestion_run_id: expect.any(String),
      accepted: 0,
      deduped: 8,
      rejected: 0,
      rejected_details: [],
    });

    await expect(getSessions(fixture.profileId, sessions.map((session) => session.session_id)))
      .resolves
      .toHaveLength(8);
    await expect(getProfile(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });
    await expect(getIngestionRun(secondBody.ingestion_run_id)).resolves.toMatchObject({
      id: secondBody.ingestion_run_id,
      status: 'completed',
      session_count: 8,
      duplicate_count: 8,
      rejected_count: 0,
      rejected_details_json: [],
    });

    const fraudRejections = (await getAuditEvents(fixture.profileId, 'fraud.rejected'));
    expect(fraudRejections).toHaveLength(0);
  });
});

describe.sequential('Task 89 audit event integration', () => {
  it('records per-session accept, dedup, and mode escalation audit events', async () => {
    const fixture = await createScriptFixture('task89_audit');
    const sessions = buildSessions(uniqueLabel('task89-audit'), 8);
    const request = buildPayload('audit-first', sessions);
    const first = await postScriptSessions(fixture.plaintext, request);
    const second = await postScriptSessions(fixture.plaintext, request);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);

    const acceptEvents = await getAuditEvents(fixture.profileId, 'ingestion.accepted');
    expect(acceptEvents).toHaveLength(8);
    expect(acceptEvents.every((event) => event.severity === 'info')).toBe(true);
    expect(acceptEvents.map((event) => event.payload.session_id).sort())
      .toEqual(sessions.map((session) => session.session_id).sort());
    expect(acceptEvents.every((event) => event.payload.reason_code === 'accepted')).toBe(true);

    const modeEvents = await getAuditEvents(fixture.profileId, 'profile.mode_escalation');
    expect(modeEvents).toEqual([
      expect.objectContaining({
        severity: 'info',
        payload: {
          previous_mode: 'self_reported',
          next_mode: 'script_verified',
        },
      }),
    ]);

    const dedupEvents = await getAuditEvents(fixture.profileId, 'ingestion.deduped');
    expect(dedupEvents).toHaveLength(8);
    expect(dedupEvents.every((event) => event.severity === 'info')).toBe(true);
    expect(dedupEvents.map((event) => event.payload.session_id).sort())
      .toEqual(sessions.map((session) => session.session_id).sort());
    expect(dedupEvents.every((event) => event.payload.reason_code === 'deduped')).toBe(true);
  });

  it('records mixed accept/reject severities and rejects invalid audit severity values', async () => {
    const mixedFixture = await createScriptFixture('task89_mixed');
    const valid = buildSession(uniqueLabel('task89-mixed-valid'), 0);
    const rejected = buildSession(uniqueLabel('task89-mixed-reject'), 1, {
      input_tokens: 200_000_000, // exceeds MAX_TOTAL_TOKENS -> bounds_violation
    });
    const mixed = await postScriptSessions(
      mixedFixture.plaintext,
      buildPayload('audit-mixed', [valid, rejected]),
    );

    expect(mixed.statusCode).toBe(202);
    expect(mixed.json()).toMatchObject({
      accepted: 1,
      deduped: 0,
      rejected: 1,
      rejected_details: [
        {
          session_id: rejected.session_id,
          reason_code: 'bounds_violation',
        },
      ],
    });

    await expect(getAuditEvents(mixedFixture.profileId, 'ingestion.accepted')).resolves.toEqual([
      expect.objectContaining({
        severity: 'info',
        payload: expect.objectContaining({
          session_id: valid.session_id,
          reason_code: 'accepted',
        }),
      }),
    ]);
    await expect(getAuditEvents(mixedFixture.profileId, 'ingestion.rejected')).resolves.toEqual([
      expect.objectContaining({
        severity: 'warn',
        payload: expect.objectContaining({
          session_id: rejected.session_id,
          reason_code: 'bounds_violation',
        }),
      }),
    ]);

    const { error } = await admin
      .from('audit_events')
      .insert({
        profile_id: mixedFixture.profileId,
        event_type: 'task89.invalid_severity',
        severity: 'error',
        payload: {},
      });

    expect(error).toBeTruthy();
    expect(error?.message).toMatch(/audit_events_severity_check|violates check constraint/i);
  });
});
