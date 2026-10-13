import { createPostgresClient, quoteIdentifier } from '../../src/lib/postgres';

export async function runSql<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await createPostgresClient();

  try {
    const result = await client.query<T>(sql, params);

    return result.rows;
  } finally {
    await client.end();
  }
}

export function q(schema: string): string {
  return quoteIdentifier(schema);
}

export async function ensureLeaderboardMaterializedView(schema: string): Promise<void> {
  const quotedSchema = q(schema);

  await runSql(`
    DO $$
    DECLARE
      leaderboard_relkind "char";
    BEGIN
      SELECT relkind
      INTO leaderboard_relkind
      FROM pg_class
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_namespace.nspname = '${schema.replace(/'/g, "''")}'
        AND pg_class.relname = 'leaderboard_lifetime';

      IF leaderboard_relkind = 'm' THEN
        EXECUTE 'DROP MATERIALIZED VIEW ${quotedSchema}.leaderboard_lifetime CASCADE';
      ELSIF leaderboard_relkind IS NOT NULL THEN
        EXECUTE 'DROP TABLE ${quotedSchema}.leaderboard_lifetime CASCADE';
      END IF;
    END $$;

    CREATE MATERIALIZED VIEW ${quotedSchema}.leaderboard_lifetime AS
      SELECT p.id AS profile_id,
             p.handle,
             p.display_name,
             p.avatar_url,
             p.verified,
             p.mode,
             COALESCE(SUM(da.total_tokens), 0)::bigint AS lifetime_tokens,
             COALESCE(SUM(da.total_sessions), 0)::bigint AS lifetime_sessions,
             MAX(da.date) AS last_active_date
      FROM ${quotedSchema}.profiles p
      LEFT JOIN ${quotedSchema}.daily_aggregates da ON da.profile_id = p.id
      GROUP BY p.id, p.handle, p.display_name, p.avatar_url, p.verified, p.mode;

    CREATE UNIQUE INDEX idx_lb_lifetime_profile ON ${quotedSchema}.leaderboard_lifetime (profile_id);
    CREATE INDEX idx_lb_lifetime_sort ON ${quotedSchema}.leaderboard_lifetime
      (verified DESC, lifetime_tokens DESC, profile_id);

    CREATE TABLE IF NOT EXISTS ${quotedSchema}.leaderboard_previous (
      profile_id uuid PRIMARY KEY REFERENCES ${quotedSchema}.profiles(id) ON DELETE CASCADE,
      rank integer NOT NULL CHECK (rank > 0),
      total_tokens bigint NOT NULL DEFAULT 0,
      refreshed_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function ensureExpandedLeaderboardMaterializedView(
  schema: string,
  multiplier: number,
): Promise<void> {
  const quotedSchema = q(schema);

  await runSql(`
    DO $$
    DECLARE
      leaderboard_relkind "char";
    BEGIN
      SELECT relkind
      INTO leaderboard_relkind
      FROM pg_class
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_namespace.nspname = '${schema.replace(/'/g, "''")}'
        AND pg_class.relname = 'leaderboard_lifetime';

      IF leaderboard_relkind = 'm' THEN
        EXECUTE 'DROP MATERIALIZED VIEW ${quotedSchema}.leaderboard_lifetime CASCADE';
      ELSIF leaderboard_relkind IS NOT NULL THEN
        EXECUTE 'DROP TABLE ${quotedSchema}.leaderboard_lifetime CASCADE';
      END IF;
    END $$;

    CREATE MATERIALIZED VIEW ${quotedSchema}.leaderboard_lifetime AS
      WITH expanded AS (
        SELECT
          p.id AS profile_id,
          p.handle,
          p.display_name,
          p.avatar_url,
          p.verified,
          p.mode,
          da.total_tokens,
          da.total_sessions,
          da.date
        FROM ${quotedSchema}.profiles p
        LEFT JOIN ${quotedSchema}.daily_aggregates da ON da.profile_id = p.id
        CROSS JOIN generate_series(1, ${multiplier}) generated(row_number)
      )
      SELECT
        profile_id,
        handle,
        display_name,
        avatar_url,
        verified,
        mode,
        COALESCE(SUM(total_tokens), 0)::bigint AS lifetime_tokens,
        COALESCE(SUM(total_sessions), 0)::bigint AS lifetime_sessions,
        MAX(date) AS last_active_date
      FROM expanded
      GROUP BY profile_id, handle, display_name, avatar_url, verified, mode;

    CREATE UNIQUE INDEX idx_lb_lifetime_profile ON ${quotedSchema}.leaderboard_lifetime (profile_id);
    CREATE INDEX idx_lb_lifetime_sort ON ${quotedSchema}.leaderboard_lifetime
      (verified DESC, lifetime_tokens DESC, profile_id);

    CREATE TABLE IF NOT EXISTS ${quotedSchema}.leaderboard_previous (
      profile_id uuid PRIMARY KEY REFERENCES ${quotedSchema}.profiles(id) ON DELETE CASCADE,
      rank integer NOT NULL CHECK (rank > 0),
      total_tokens bigint NOT NULL DEFAULT 0,
      refreshed_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function seedProfiles(schema: string, label: string, count: number): Promise<void> {
  const quotedSchema = q(schema);

  await runSql(`
    WITH generated AS (
      SELECT
        gen_random_uuid() AS id,
        ${label === '' ? "'profile'" : '$1'} || '_' || generate_series AS handle
      FROM generate_series(1, $2::integer)
    ),
    inserted_users AS (
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
        handle || '-' || id::text || '@example.com',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
      FROM generated
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    INSERT INTO ${quotedSchema}.profiles (id, user_id, handle, display_name, mode, verified)
    SELECT
      generated.id,
      generated.id,
      generated.handle,
      generated.handle,
      'script_verified',
      true
    FROM generated
    ON CONFLICT (id) DO NOTHING
  `, [label, count]);
}
