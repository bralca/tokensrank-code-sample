import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IngestRequest, SessionPayload } from '@tokensrank/shared';

import { buildServer } from '../../src/server';
import {
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

type ProfileMode = 'script_verified' | 'self_reported' | null;
type AccessKeyFixture = Awaited<ReturnType<typeof createAccessKeyFixture>>;

const createdUserIds = new Set<string>();
let app: Awaited<ReturnType<typeof buildServer>>;
let admin: ReturnType<typeof createSchemaServiceRoleClient>;

function sha(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function session(label: string, overrides: Partial<SessionPayload> = {}): SessionPayload {
  const baseMs = Date.now() - (5 * 60 * 60 * 1000);

  return {
    session_id: label,
    model: 'claude-3-5-sonnet-20241022',
    source: 'claude',
    first_event_at: iso(baseMs),
    last_event_at: iso(baseMs + (8 * 60 * 1000)),
    input_tokens: 11_000,
    output_tokens: 2_500,
    cache_read_input_tokens: 700,
    cache_creation_input_tokens: 200,
    cached_input_tokens: 100,
    reasoning_output_tokens: 50,
    turns: 3,
    file_sha256: sha(label),
    ...overrides,
  };
}

function payload(label: string, sessions: SessionPayload[]): IngestRequest {
  const firstEventTimes = sessions.map((item) => new Date(item.first_event_at).getTime());
  const lastEventTimes = sessions.map((item) => new Date(item.last_event_at).getTime());

  return {
    client: {
      version: '1.0.0',
      install_id: crypto.randomUUID(),
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: `qc3-mode-${label}-${crypto.randomUUID()}`,
      started_at: iso(Math.min(...firstEventTimes)),
      finished_at: iso(Math.max(...lastEventTimes)),
    },
    sessions,
  };
}

function totalTokens(item: SessionPayload): number {
  return item.input_tokens
    + item.output_tokens
    + item.cache_read_input_tokens
    + item.cache_creation_input_tokens
    + item.cached_input_tokens
    + item.reasoning_output_tokens;
}

async function createFixture(scope: 'script' | 'self_reported', label: string): Promise<AccessKeyFixture> {
  const fixture = await createAccessKeyFixture(scope, label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function postSessions(url: string, plaintext: string, body: IngestRequest) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${plaintext}`,
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
    throw new Error(`[mode-escalation-test] profile setup failed: ${error.message}`);
  }
}

async function getProfile(profileId: string): Promise<{ mode: ProfileMode; verified: boolean }> {
  const { data, error } = await admin
    .from('profiles')
    .select('mode, verified')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[mode-escalation-test] profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return data as { mode: ProfileMode; verified: boolean };
}

async function getSessionMode(profileId: string, sessionId: string): Promise<string> {
  const { data, error } = await admin
    .from('sessions')
    .select('ingestion_mode')
    .eq('profile_id', profileId)
    .eq('session_id', sessionId)
    .single();

  if (error || !data) {
    throw new Error(`[mode-escalation-test] session lookup failed: ${error?.message ?? 'missing session'}`);
  }

  return (data as { ingestion_mode: string }).ingestion_mode;
}

async function getModeEscalationAuditEvents(profileId: string) {
  const { data, error } = await admin
    .from('audit_events')
    .select('event_type, severity, payload')
    .eq('profile_id', profileId)
    .eq('event_type', 'profile.mode_escalation')
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`[mode-escalation-test] audit lookup failed: ${error.message}`);
  }

  return (data ?? []) as Array<{
    event_type: string;
    severity: string;
    payload: Record<string, unknown>;
  }>;
}

async function getAggregate(profileId: string, item: SessionPayload) {
  const { data, error } = await admin
    .from('daily_aggregates')
    .select('date, source, model, total_tokens, total_sessions')
    .eq('profile_id', profileId)
    .eq('date', item.last_event_at.slice(0, 10))
    .eq('source', item.source)
    .eq('model', item.model)
    .single();

  if (error || !data) {
    throw new Error(`[mode-escalation-test] aggregate lookup failed: ${error?.message ?? 'missing aggregate'}`);
  }

  return data as {
    date: string;
    source: string;
    model: string;
    total_tokens: number | string;
    total_sessions: number;
  };
}

beforeAll(async () => {
  admin = createSchemaServiceRoleClient();
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe.sequential('QC-3 mode escalation endpoint coherence', () => {
  it('escalates a self_reported profile to script_verified through the script endpoint', async () => {
    const fixture = await createFixture('script', 'qc3_b_to_a');
    const item = session('qc3-mode-b-to-a');
    const response = await postSessions('/api/script/sessions', fixture.plaintext, payload('b-to-a', [item]));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 1, rejected: 0, deduped: 0 });
    await expect(getProfile(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });
    await expect(getSessionMode(fixture.profileId, item.session_id)).resolves.toBe('script_verified');

    const auditEvents = await getModeEscalationAuditEvents(fixture.profileId);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        event_type: 'profile.mode_escalation',
        severity: 'info',
        payload: {
          previous_mode: 'self_reported',
          next_mode: 'script_verified',
        },
      }),
    ]);

    const aggregate = await getAggregate(fixture.profileId, item);
    expect(Number(aggregate.total_tokens)).toBe(totalTokens(item));
    expect(aggregate.total_sessions).toBe(1);
  });

  it('escalates a NULL profile mode to script_verified through the script endpoint', async () => {
    const fixture = await createFixture('script', 'qc3_null_to_a');
    const item = session('qc3-mode-null-to-a');

    await setProfileMode(fixture.profileId, null);

    const response = await postSessions('/api/script/sessions', fixture.plaintext, payload('null-to-a', [item]));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 1, rejected: 0, deduped: 0 });
    await expect(getProfile(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });

    const auditEvents = await getModeEscalationAuditEvents(fixture.profileId);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        severity: 'info',
        payload: {
          previous_mode: null,
          next_mode: 'script_verified',
        },
      }),
    ]);
  });

  it('does not downgrade a script_verified profile on self-reported ingestion', async () => {
    const fixture = await createFixture('self_reported', 'qc3_no_down');
    const item = session('qc3-mode-no-downgrade');

    await setProfileMode(fixture.profileId, 'script_verified');

    const response = await postSessions('/api/self-reported/sessions', fixture.plaintext, payload('no-downgrade', [item]));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 1, rejected: 0, deduped: 0 });
    await expect(getProfile(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });
    await expect(getSessionMode(fixture.profileId, item.session_id)).resolves.toBe('self_reported');
    await expect(getModeEscalationAuditEvents(fixture.profileId)).resolves.toEqual([]);
  });

  it('records mode escalation once even when later script ingestions are accepted', async () => {
    const fixture = await createFixture('script', 'qc3_idemp');
    const first = session('qc3-mode-idempotent-first');
    const second = session('qc3-mode-idempotent-second', {
      first_event_at: first.first_event_at,
      last_event_at: first.last_event_at,
    });

    const firstResponse = await postSessions('/api/script/sessions', fixture.plaintext, payload('idempotent-first', [first]));
    const secondResponse = await postSessions('/api/script/sessions', fixture.plaintext, payload('idempotent-second', [second]));

    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(202);
    expect(firstResponse.json()).toMatchObject({ accepted: 1, rejected: 0, deduped: 0 });
    expect(secondResponse.json()).toMatchObject({ accepted: 1, rejected: 0, deduped: 0 });
    await expect(getProfile(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });
    await expect(getModeEscalationAuditEvents(fixture.profileId)).resolves.toHaveLength(1);
  });

  it('upserts daily aggregates across accepted batches for the same profile, date, source, and model', async () => {
    const fixture = await createFixture('script', 'qc3_aggs');
    const baseMs = Date.now() - (3 * 60 * 60 * 1000);
    const first = session('qc3-mode-aggregate-first', {
      first_event_at: iso(baseMs),
      last_event_at: iso(baseMs + (6 * 60 * 1000)),
      input_tokens: 1_000,
      output_tokens: 250,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
      cached_input_tokens: 25,
      reasoning_output_tokens: 10,
    });
    const second = session('qc3-mode-aggregate-second', {
      first_event_at: first.first_event_at,
      last_event_at: first.last_event_at,
      input_tokens: 2_000,
      output_tokens: 500,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
      cached_input_tokens: 50,
      reasoning_output_tokens: 20,
    });

    const firstResponse = await postSessions('/api/script/sessions', fixture.plaintext, payload('aggregate-first', [first]));
    const secondResponse = await postSessions('/api/script/sessions', fixture.plaintext, payload('aggregate-second', [second]));

    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(202);

    const aggregate = await getAggregate(fixture.profileId, first);
    expect(Number(aggregate.total_tokens)).toBe(totalTokens(first) + totalTokens(second));
    expect(aggregate.total_sessions).toBe(2);
    await expect(getModeEscalationAuditEvents(fixture.profileId)).resolves.toHaveLength(1);
  });
});
