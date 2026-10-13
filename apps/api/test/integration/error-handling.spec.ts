import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import { recordAuditEvent } from '../../src/services/audit';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

type LogLine = Record<string, unknown>;

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const createdUserIds = new Set<string>();
const logs: LogLine[] = [];

let app: Awaited<ReturnType<typeof buildServer>>;
let admin: ReturnType<typeof createSchemaServiceRoleClient>;
let profileId: string;
let scriptKey: string;

function captureLogLine(line: string): void {
  for (const entry of line.trim().split('\n')) {
    if (!entry) {
      continue;
    }

    logs.push(JSON.parse(entry) as LogLine);
  }
}

function createEventType(prefix: string): string {
  return `${prefix}.${crypto.randomUUID().slice(0, 8)}`;
}

function latestLog(event: string): LogLine | undefined {
  return logs.findLast((line) => line.event === event);
}

async function readAuditEvents(eventType: string) {
  const { data, error } = await admin
    .from('audit_events')
    .select('event_type, severity, profile_id, payload')
    .eq('profile_id', profileId)
    .eq('event_type', eventType);

  if (error) {
    throw new Error(`[error-handling-test] read audit events failed: ${error.message}`);
  }

  return data ?? [];
}

beforeAll(async () => {
  admin = createSchemaServiceRoleClient();
  app = await buildServer({
    logger: {
      level: 'info',
      stream: {
        write: captureLogLine,
      },
    },
  });

  app.get('/__test/error', async () => {
    throw new Error('forced failure at /Users/alice/private/project.ts');
  });

  app.get('/__test/request-context', async (request) => ({
    requestId: request.requestId,
    boundRequestId: request.log.bindings().request_id,
  }));

  await app.ready();

  const fixture = await createAccessKeyFixture('script', 'logging');
  profileId = fixture.profileId;
  scriptKey = fixture.plaintext;
  createdUserIds.add(fixture.userId);
});

beforeEach(() => {
  logs.length = 0;
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe('structured logging and error handling integration', () => {
  it('adds an X-Request-ID ULID to health responses', async () => {
    const response = await app.inject('/health');

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toMatch(ulidPattern);
  });

  it('generates a unique request ID for every response', async () => {
    const first = await app.inject('/health');
    const second = await app.inject('/health');

    expect(first.headers['x-request-id']).toMatch(ulidPattern);
    expect(second.headers['x-request-id']).toMatch(ulidPattern);
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('binds request_id into request.log context', async () => {
    const response = await app.inject('/__test/request-context');
    const body = response.json<{ requestId: string; boundRequestId: string }>();

    expect(body.requestId).toBe(response.headers['x-request-id']);
    expect(body.boundRequestId).toBe(body.requestId);
  });

  it('emits structured request.complete logs with request_id, status, and latency', async () => {
    const response = await app.inject('/health');
    const line = latestLog('request.complete');

    expect(line).toEqual(expect.objectContaining({
      event: 'request.complete',
      request_id: response.headers['x-request-id'],
      status_code: 200,
      method: 'GET',
      url: '/health',
    }));
    expect(typeof line?.latency_ms).toBe('number');
  });

  it('returns a safe error envelope with no stack trace', async () => {
    const response = await app.inject('/__test/error');

    expect(response.statusCode).toBe(500);
    expect(response.headers['x-request-id']).toMatch(ulidPattern);
    expect(response.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'An error occurred',
      },
    });
    expect(response.body).not.toContain('stack');
    expect(response.body).not.toContain('/Users/alice');
  });

  it('logs unhandled errors with redacted message and stack trace', async () => {
    const response = await app.inject('/__test/error');
    const line = latestLog('error.unhandled');

    expect(line).toEqual(expect.objectContaining({
      event: 'error.unhandled',
      request_id: response.headers['x-request-id'],
      severity: 'critical',
      status_code: 500,
    }));
    expect(String(line?.error_message)).toContain('/[HOME]/private/project.ts');
    expect(String(line?.error_stack)).toContain('/[HOME]/private/project.ts');
    expect(String(line?.error_stack)).not.toContain('/Users/alice');
  });

  it('persists recordAuditEvent rows to real Supabase Dev', async () => {
    const eventType = createEventType('audit');

    await recordAuditEvent({
      eventType,
      severity: 'info',
      profileId,
      details: { reason_code: 'integration_probe' },
      requestLog: app.log,
      supabaseClient: admin,
    });

    expect(await readAuditEvents(eventType)).toContainEqual(expect.objectContaining({
      event_type: eventType,
      severity: 'info',
      profile_id: profileId,
      payload: { reason_code: 'integration_probe' },
    }));
  });

  it('emits ingestion.completed and request.complete logs for accepted ingestion', async () => {
    const payload = buildIngestPayload(1, `logger-${crypto.randomUUID()}`);
    const response = await app.inject({
      method: 'POST',
      url: '/api/script/sessions',
      headers: {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${scriptKey}`,
      },
      payload,
    });
    const body = response.json<{ ingestion_run_id: string; accepted: number; rejected: number; deduped: number }>();

    expect(response.statusCode).toBe(202);
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
    expect(body.deduped).toBe(0);
    expect(latestLog('ingestion.completed')).toEqual(expect.objectContaining({
      event: 'ingestion.completed',
      request_id: response.headers['x-request-id'],
      ingestion_run_id: body.ingestion_run_id,
      profile_id: profileId,
      mode: 'script_verified',
      status: 'completed',
      accepted_count: 1,
      rejected_count: 0,
      deduped_count: 0,
    }));
    expect(latestLog('request.complete')).toEqual(expect.objectContaining({
      event: 'request.complete',
      request_id: response.headers['x-request-id'],
      status_code: 202,
      url: '/api/script/sessions',
    }));
  });
});
