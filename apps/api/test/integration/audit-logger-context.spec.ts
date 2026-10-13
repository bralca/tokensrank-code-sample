import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { writeAuditEvent } from '../../src/services/audit';

type LogLine = Record<string, unknown>;

const logs: LogLine[] = [];

function captureLogLine(line: string): void {
  for (const entry of line.trim().split('\n')) {
    if (!entry) {
      continue;
    }

    logs.push(JSON.parse(entry) as LogLine);
  }
}

const app = Fastify({
  logger: {
    level: 'debug',
    stream: {
      write: captureLogLine,
    },
  },
});

beforeAll(async () => {
  app.get('/audit-event', async (request) => {
    await writeAuditEvent({
      event_type: 'audit.logger_event',
      severity: 'info',
      payload: { reason_code: 'logger_event' },
      requestLog: request.log.child({
        request_id: request.headers['x-request-id'],
      }),
    });

    return { ok: true };
  });

  app.get('/audit-event-compat', async (request) => {
    await writeAuditEvent({
      event_type: 'audit.logger_compat',
      severity: 'info',
      payload: { reason_code: 'logger_compat' },
      requestLog: request.log.child({
        request_id: request.headers['x-request-id'],
      }),
      supabaseClient: {
        from: vi.fn(() => ({
          insert: vi.fn(() => Promise.resolve({
            data: null,
            error: { message: 'forced insert failure' },
          })),
        })),
      },
    });

    return { ok: true };
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('writeAuditEvent request logger context', () => {
  it('preserves request_id on audit.event logs from the Fastify child logger', async () => {
    logs.length = 0;

    const response = await app.inject({
      method: 'GET',
      url: '/audit-event',
      headers: {
        'x-request-id': 'req-audit-event',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(logs).toContainEqual(expect.objectContaining({
      event: 'audit.event',
      event_type: 'audit.logger_event',
      request_id: 'req-audit-event',
      severity: 'info',
    }));
  });

  it('ignores legacy supabaseClient input and still logs audit.event context', async () => {
    logs.length = 0;

    const response = await app.inject({
      method: 'GET',
      url: '/audit-event-compat',
      headers: {
        'x-request-id': 'req-audit-compat',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(logs).toContainEqual(expect.objectContaining({
      event: 'audit.event',
      event_type: 'audit.logger_compat',
      request_id: 'req-audit-compat',
      severity: 'info',
    }));
  });
});
