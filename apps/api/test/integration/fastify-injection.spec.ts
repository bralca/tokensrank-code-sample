import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server';

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('Fastify app injection', () => {
  it('serves the health endpoint without opening a network port', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
