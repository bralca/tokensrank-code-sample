import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESERVED_HANDLES_ARRAY } from '@tokensrank/shared';

import { buildServer } from '../../src/server';

import { q, runSql } from './db-test-helpers';
import { resolveTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const reservableHandles = RESERVED_HANDLES_ARRAY.filter((handle) => handle.length >= 3);

let app: Awaited<ReturnType<typeof buildServer>>;

async function seedProfile(handle: string): Promise<void> {
  const quotedSchema = q(schema);
  const rows = await runSql<{ id: string }>(`
    WITH generated AS (
      SELECT gen_random_uuid() AS id
    ),
    inserted_user AS (
      INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
      )
      SELECT
        id,
        'authenticated',
        'authenticated',
        'handle-check-' || $1 || '-' || id::text || '@example.com',
        '{}'::jsonb,
        jsonb_build_object('test_schema', $2::text),
        now(),
        now()
      FROM generated
      RETURNING id
    )
    INSERT INTO ${quotedSchema}.profiles (id, user_id, handle, mode, verified)
    SELECT id, id, $1::text, 'self_reported', false
    FROM inserted_user
    RETURNING id
  `, [handle, schema]);

  if (rows[0]?.id) {
    createdUserIds.add(rows[0].id);
  }
}

async function checkHandle(handle: string, path = '/api/handle/check') {
  return await app.inject({
    method: 'GET',
    url: `${path}?h=${encodeURIComponent(handle)}`,
  });
}

beforeAll(async () => {
  app = await buildServer({
    logger: false,
  });
  await app.ready();
  await seedProfile('alex');
});

afterAll(async () => {
  await app?.close();

  if (createdUserIds.size > 0) {
    await runSql(`
      DELETE FROM auth.users
      WHERE id = ANY($1::uuid[])
    `, [Array.from(createdUserIds)]);
  }
});

describe('GET /api/handle/check', () => {
  it('returns available for a valid unclaimed handle', async () => {
    const response = await checkHandle('alexchen');

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.headers['x-tokensrank-cache']).toBeUndefined();
    expect(response.json()).toEqual({
      data: {
        available: true,
      },
    });
  });

  it.each([
    '',
    'ab',
    'a'.repeat(31),
    'Alex',
    'user.name',
    'user handle',
    'user@123',
  ])('returns invalid_format for invalid handle "%s"', async (handle) => {
    const response = await checkHandle(handle);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        available: false,
        reason: 'invalid_format',
      },
    });
  });

  it.each(reservableHandles)('returns reserved for reserved handle "%s"', async (handle) => {
    const response = await checkHandle(handle);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        available: false,
        reason: 'reserved',
      },
    });
  });

  it('returns already_taken for a claimed handle', async () => {
    const response = await checkHandle('alex');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        available: false,
        reason: 'already_taken',
      },
    });
  });

  it('also serves the task-title plural route alias', async () => {
    const response = await checkHandle('alexchen2', '/api/handles/check');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        available: true,
      },
    });
  });

  it('returns a uniform error envelope when the query parameter is missing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/handle/check',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'invalid_handle_check_query',
        message: 'Missing required handle query parameter',
      },
    });
  });
});
