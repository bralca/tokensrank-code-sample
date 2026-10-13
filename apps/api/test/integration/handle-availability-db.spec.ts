import { describe, expect, it } from 'vitest';

import { isHandleAvailableInDb } from '../../src/services/profile';

import { q, runSql } from './db-test-helpers';
import { resolveTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();

async function seedProfile(handle: string): Promise<void> {
  const quotedSchema = q(schema);

  await runSql(`
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
        $1 || '-' || id::text || '@example.com',
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
  `, [handle, schema]);
}

describe('isHandleAvailableInDb', () => {
  it('matches existing profile handles case-insensitively', async () => {
    await seedProfile('alex');

    await expect(isHandleAvailableInDb('alex')).resolves.toBe(false);
    await expect(isHandleAvailableInDb('ALEX')).resolves.toBe(false);
    await expect(isHandleAvailableInDb('Alex')).resolves.toBe(false);
    await expect(isHandleAvailableInDb('alexchen')).resolves.toBe(true);
  });
});
