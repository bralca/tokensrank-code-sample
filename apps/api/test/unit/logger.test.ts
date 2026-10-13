import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
});

import { createErrorEnvelope, errorHandlerPlugin } from '../../src/plugins/error-handler';
import { requestIdPlugin } from '../../src/plugins/request-id';
import { redactLogMessage, redactStackTrace } from '../../src/lib/logger-privacy';

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('logger privacy redaction', () => {
  it('returns undefined for undefined log messages', () => {
    expect(redactLogMessage(undefined)).toBeUndefined();
  });

  it('returns undefined for undefined stack traces', () => {
    expect(redactStackTrace(undefined)).toBeUndefined();
  });

  it('redacts the configured HOME path in log messages', () => {
    vi.stubEnv('HOME', '/Users/alice');

    expect(redactLogMessage('failed at /Users/alice/project/file.ts')).toBe('failed at /[HOME]/project/file.ts');
  });

  it('redacts the configured USERPROFILE path and normalizes separators', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\Alice');

    expect(redactLogMessage('failed at C:\\Users\\Alice\\project\\file.ts')).toBe('failed at /[HOME]/project/file.ts');
  });

  it('redacts common macOS home paths without relying on env', () => {
    expect(redactLogMessage('at /Users/builder/project/index.ts')).toBe('at /[HOME]/project/index.ts');
  });

  it('redacts common Linux home paths without relying on env', () => {
    expect(redactLogMessage('at /home/builder/project/index.ts')).toBe('at /[HOME]/project/index.ts');
  });

  it('redacts common Windows home paths without relying on env', () => {
    expect(redactLogMessage('at C:\\Users\\builder\\project\\index.ts')).toBe('at /[HOME]/project/index.ts');
  });

  it('redacts every line in a multiline stack trace', () => {
    vi.stubEnv('HOME', '/Users/alice');
    const redacted = redactStackTrace([
      'Error: boom',
      '    at first (/Users/alice/project/a.ts:1:1)',
      '    at second (/home/bob/project/b.ts:2:2)',
    ].join('\n'));

    expect(redacted).not.toContain('/Users/alice');
    expect(redacted).not.toContain('/home/bob');
    expect(redacted).toContain('/[HOME]/project/a.ts');
    expect(redacted).toContain('/[HOME]/project/b.ts');
  });

  it('leaves messages without path-like PII unchanged', () => {
    expect(redactLogMessage('plain operational message')).toBe('plain operational message');
  });
});

describe('logger exports and configuration', () => {
  it('exports a pino logger with child logger support', async () => {
    const { logger } = await import('../../src/lib/logger');

    expect(typeof logger.info).toBe('function');
    expect(typeof logger.child).toBe('function');
  });

  it('exports pino-http configuration and a Fastify http logger plugin', async () => {
    const { httpLogger, pinoHttpLogger } = await import('../../src/lib/logger');

    expect(typeof httpLogger).toBe('function');
    expect(typeof pinoHttpLogger).toBe('function');
  });

  it('omits pretty transport in production configuration', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');

    const { loggerOptions } = await import('../../src/lib/logger');

    expect(loggerOptions.transport).toBeUndefined();
  });

  it('enables pino-pretty transport in development configuration', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'development');

    const { loggerOptions } = await import('../../src/lib/logger');

    expect(loggerOptions.transport).toEqual(expect.objectContaining({
      target: 'pino-pretty',
    }));
  });
});

describe('request ID plugin', () => {
  it('adds a 26-character ULID to each response header and request object', async () => {
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get('/probe', async (request) => ({ requestId: request.requestId }));

    const response = await app.inject('/probe');
    const body = response.json<{ requestId: string }>();

    expect(response.headers['x-request-id']).toMatch(ulidPattern);
    expect(body.requestId).toBe(response.headers['x-request-id']);
    await app.close();
  });

  it('generates unique request IDs for separate requests', async () => {
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get('/probe', async (request) => ({ requestId: request.requestId }));

    const first = await app.inject('/probe');
    const second = await app.inject('/probe');

    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
    await app.close();
  });

  it('binds request_id into the request child logger', async () => {
    const app = Fastify({ logger: true });
    await app.register(requestIdPlugin);
    app.get('/probe', async (request) => ({
      requestId: request.requestId,
      boundRequestId: request.log.bindings().request_id,
    }));

    const response = await app.inject('/probe');
    const body = response.json<{ requestId: string; boundRequestId: string }>();

    expect(body.boundRequestId).toBe(body.requestId);
    await app.close();
  });
});

describe('error envelope safety', () => {
  it('creates a generic 500 envelope without stack details', () => {
    const error = Object.assign(new Error('secret /Users/alice/project/file.ts'), {
      code: 'ERR_SECRET',
      statusCode: 500,
    });

    const envelope = createErrorEnvelope(error);

    expect(envelope.statusCode).toBe(500);
    expect(envelope.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'An error occurred',
      },
    });
    expect(JSON.stringify(envelope.body)).not.toContain('stack');
    expect(JSON.stringify(envelope.body)).not.toContain('/Users/alice');
  });

  it('creates a safe non-5xx envelope with no original message leakage', () => {
    const error = Object.assign(new Error('internal validation path /home/alice/project'), {
      code: 'BAD_REQUEST',
      statusCode: 400,
    });

    const envelope = createErrorEnvelope(error);

    expect(envelope).toEqual({
      statusCode: 400,
      body: {
        error: {
          code: 'bad_request',
          message: 'Request failed',
        },
      },
    });
  });

  it('error handler responses never expose stack traces', async () => {
    const app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    await app.register(errorHandlerPlugin);
    app.get('/throws', async () => {
      throw new Error('boom /Users/alice/project/file.ts');
    });

    const response = await app.inject('/throws');

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
    await app.close();
  });
});
