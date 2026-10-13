import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

type LogLine = Record<string, unknown>;

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const createdUserIds = new Set<string>();
const logs: LogLine[] = [];

let app: Awaited<ReturnType<typeof buildServer>>;
let admin: ReturnType<typeof createSchemaServiceRoleClient>;
let fixture: Awaited<ReturnType<typeof createAccessKeyFixture>>;

function captureLogLine(line: string): void {
  for (const entry of line.trim().split('\n')) {
    if (!entry) {
      continue;
    }

    logs.push(JSON.parse(entry) as LogLine);
  }
}

function latestLog(event: string): LogLine | undefined {
  return logs.findLast((line) => line.event === event);
}

function logsForRequest(requestId: string): LogLine[] {
  return logs.filter((line) => line.request_id === requestId);
}

async function postScriptIngestion(label: string) {
  return app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${fixture.plaintext}`,
    },
    payload: buildIngestPayload(1, `qc3-logger-${label}-${crypto.randomUUID()}`),
  });
}

async function readFraudAuditEvents() {
  const { data, error } = await admin
    .from('audit_events')
    .select('event_type, severity, payload')
    .eq('profile_id', fixture.profileId)
    .in('event_type', ['fraud.rejected', 'fraud.fingerprint_drift'])
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`[logger-test] audit lookup failed: ${error.message}`);
  }

  return data ?? [];
}

beforeAll(async () => {
  admin = createSchemaServiceRoleClient();
  app = await buildServer({
    logger: {
      level: 'debug',
      stream: {
        write: captureLogLine,
      },
    },
  });

  app.get('/__test/logger/error', async () => {
    throw new Error('forced failure at /Users/alice/private/project.ts');
  });

  app.get('/__test/logger/multi', async (request) => {
    request.log.info({ event: 'logger.multi.first' }, 'First request-scoped log');
    request.log.warn({ event: 'logger.multi.second' }, 'Second request-scoped log');

    return {
      request_id: request.requestId,
    };
  });

  await app.ready();

  fixture = await createAccessKeyFixture('script', 'qc3_logger');
  createdUserIds.add(fixture.userId);
});

beforeEach(() => {
  logs.length = 0;
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe.sequential('QC-3 structured logger coherence', () => {
  it('logs authenticated requests with request_id, user_id, latency, and status', async () => {
    const response = await postScriptIngestion('request-level');
    const requestId = response.headers['x-request-id'];
    const line = latestLog('request.complete');

    expect(response.statusCode).toBe(202);
    expect(requestId).toMatch(ulidPattern);
    expect(line).toEqual(expect.objectContaining({
      event: 'request.complete',
      request_id: requestId,
      user_id: fixture.userId,
      method: 'POST',
      url: '/api/script/sessions',
      status: 202,
      status_code: 202,
    }));
    expect(String(line?.user_id)).toMatch(uuidPattern);
    expect(typeof line?.latency_ms).toBe('number');
  });

  it('preserves the same request_id across every log emitted during one request', async () => {
    const response = await app.inject('/__test/logger/multi');
    const body = response.json<{ request_id: string }>();
    const requestLogs = logsForRequest(body.request_id);

    expect(response.statusCode).toBe(200);
    expect(body.request_id).toBe(response.headers['x-request-id']);
    expect(requestLogs.map((line) => line.event)).toEqual([
      'logger.multi.first',
      'logger.multi.second',
      'request.complete',
    ]);
    expect(requestLogs.every((line) => line.request_id === body.request_id)).toBe(true);
  });

  it('scrubs /Users home paths from unhandled error logs', async () => {
    const response = await app.inject('/__test/logger/error');
    const line = latestLog('error.unhandled');

    expect(response.statusCode).toBe(500);
    expect(line).toEqual(expect.objectContaining({
      event: 'error.unhandled',
      request_id: response.headers['x-request-id'],
      severity: 'critical',
      status_code: 500,
    }));
    expect(String(line?.error_message)).toContain('/[HOME]/private/project.ts');
    expect(String(line?.error_stack)).toContain('/[HOME]/private/project.ts');
    expect(JSON.stringify(line)).not.toContain('/Users/alice');
  });

  it('emits an ingestion.completed event for accepted script ingestion', async () => {
    const response = await postScriptIngestion('completion');
    const body = response.json<{ ingestion_run_id: string; accepted: number; rejected: number; deduped: number }>();
    const line = latestLog('ingestion.completed');

    expect(response.statusCode).toBe(202);
    expect(body).toMatchObject({ accepted: 1, rejected: 0, deduped: 0 });
    expect(line).toEqual(expect.objectContaining({
      event: 'ingestion.completed',
      request_id: response.headers['x-request-id'],
      ingestion_run_id: body.ingestion_run_id,
      profile_id: fixture.profileId,
      mode: 'script_verified',
      status: 'completed',
      accepted_count: 1,
      rejected_count: 0,
      deduped_count: 0,
    }));
  });

  it('does not leak access keys or unsanitized private paths in runtime logs', async () => {
    await app.inject('/__test/logger/error');
    await postScriptIngestion('no-pii');

    const serialized = JSON.stringify(logs);

    expect(serialized).toContain('/[HOME]/private/project.ts');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain(fixture.plaintext);
    expect(serialized).not.toMatch(/Bearer\s+tr_script_/u);
  });
});
