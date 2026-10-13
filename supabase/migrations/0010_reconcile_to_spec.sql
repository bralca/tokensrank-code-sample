-- TokensRank Task 4.0: reconcile existing schemas to the canonical spec.
--
-- Summary of changes applied by this migration:
-- 1. Normalize profiles.mode from legacy A/B values to script_verified/self_reported.
-- 2. Normalize ingestion_mode values from legacy script to script_verified.
-- 3. Add partial to ingestion_runs.status.
-- 4. Enforce audit_events.severity as info/warn/critical only.
-- 5. Drop redundant prior-branch RLS policies.
-- 6. Verify sessions.total_tokens remains GENERATED ALWAYS.
-- 7. Verify sessions dedup uniqueness on (profile_id, source, session_id, file_sha256).
-- 8. Wipe legacy badge definitions and awards, then seed the 16 canonical badges.

BEGIN TRANSACTION;

-- Phase 1: Drop constraints that are replaced by the canonical definitions.
DO $$
DECLARE
  target_schema text;
BEGIN
  FOR target_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname = COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public')
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.profiles', target_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I.profiles DROP CONSTRAINT IF EXISTS profiles_mode_check', target_schema);
    EXECUTE format('ALTER TABLE %I.profiles DROP CONSTRAINT IF EXISTS mode_check', target_schema);

    IF to_regclass(format('%I.ingestion_runs', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.ingestion_runs DROP CONSTRAINT IF EXISTS ingestion_runs_status_check', target_schema);
      EXECUTE format('ALTER TABLE %I.ingestion_runs DROP CONSTRAINT IF EXISTS status_check', target_schema);
      EXECUTE format('ALTER TABLE %I.ingestion_runs DROP CONSTRAINT IF EXISTS ingestion_runs_ingestion_mode_check', target_schema);
      EXECUTE format('ALTER TABLE %I.ingestion_runs DROP CONSTRAINT IF EXISTS ingestion_mode_check', target_schema);
    END IF;

    IF to_regclass(format('%I.sessions', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.sessions DROP CONSTRAINT IF EXISTS sessions_ingestion_mode_check', target_schema);
      EXECUTE format('ALTER TABLE %I.sessions DROP CONSTRAINT IF EXISTS ingestion_mode_check', target_schema);
    END IF;

    IF to_regclass(format('%I.audit_events', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.audit_events DROP CONSTRAINT IF EXISTS audit_events_severity_check', target_schema);
      EXECUTE format('ALTER TABLE %I.audit_events DROP CONSTRAINT IF EXISTS severity_check', target_schema);
    END IF;

    IF to_regclass(format('%I.ingestion_runs', target_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          UPDATE %I.ingestion_runs
          SET ingestion_mode = 'script_verified'
          WHERE ingestion_mode = 'script'
        $sql$,
        target_schema
      );
    END IF;

    IF to_regclass(format('%I.sessions', target_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          UPDATE %I.sessions
          SET ingestion_mode = 'script_verified'
          WHERE ingestion_mode = 'script'
        $sql$,
        target_schema
      );
    END IF;
  END LOOP;
END;
$$;

-- Phase 2: Coerce legacy data values into canonical values.
DO $$
DECLARE
  target_schema text;
BEGIN
  FOR target_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname = COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public')
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.profiles', target_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        UPDATE %I.profiles
        SET mode = CASE
          WHEN mode = 'A' THEN 'script_verified'
          WHEN mode = 'B' THEN 'self_reported'
          ELSE mode
        END
        WHERE mode IN ('A', 'B')
      $sql$,
      target_schema
    );

    IF to_regclass(format('%I.audit_events', target_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          UPDATE %I.audit_events
          SET severity = 'critical'
          WHERE severity = 'error'
        $sql$,
        target_schema
      );
    END IF;
  END LOOP;
END;
$$;

-- Phase 3: Add canonical constraints.
DO $$
DECLARE
  target_schema text;
BEGIN
  FOR target_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname = COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public')
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.profiles', target_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        ALTER TABLE %I.profiles
          ADD CONSTRAINT profiles_mode_check
          CHECK (mode IS NULL OR mode IN ('script_verified', 'self_reported'))
      $sql$,
      target_schema
    );

    IF to_regclass(format('%I.ingestion_runs', target_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          ALTER TABLE %I.ingestion_runs
            ADD CONSTRAINT ingestion_runs_status_check
            CHECK (status IN ('processing', 'completed', 'partial', 'failed'))
        $sql$,
        target_schema
      );

      EXECUTE format(
        $sql$
          ALTER TABLE %I.ingestion_runs
            ADD CONSTRAINT ingestion_runs_ingestion_mode_check
            CHECK (ingestion_mode IN ('script_verified', 'self_reported'))
        $sql$,
        target_schema
      );
    END IF;

    IF to_regclass(format('%I.sessions', target_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          ALTER TABLE %I.sessions
            ADD CONSTRAINT sessions_ingestion_mode_check
            CHECK (ingestion_mode IN ('script_verified', 'self_reported'))
        $sql$,
        target_schema
      );
    END IF;

    IF to_regclass(format('%I.audit_events', target_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          ALTER TABLE %I.audit_events
            ADD CONSTRAINT audit_events_severity_check
            CHECK (severity IN ('info', 'warn', 'critical'))
        $sql$,
        target_schema
      );
    END IF;
  END LOOP;
END;
$$;

-- Phase 4: Drop redundant policies.
-- Ordering contract: Task 4.0 removes prior-branch duplicate policies only.
-- Task 6.0 runs after this migration and creates the authoritative RLS policy set,
-- so there is no circular dependency between policy cleanup and policy creation.
DO $$
DECLARE
  leaderboard_relkind "char";
  target_schema text;
BEGIN
  FOR target_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname = COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public')
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.profiles', target_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    IF to_regclass(format('%I.access_keys', target_schema)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS access_keys_select_own ON %I.access_keys', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS access_keys_update_own ON %I.access_keys', target_schema);
    END IF;

    IF to_regclass(format('%I.sessions', target_schema)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS sessions_select_own ON %I.sessions', target_schema);
    END IF;

    IF to_regclass(format('%I.daily_aggregates', target_schema)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS daily_aggregates_select_own ON %I.daily_aggregates', target_schema);
    END IF;

    IF to_regclass(format('%I.badges', target_schema)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS badges_select_public ON %I.badges', target_schema);
    END IF;

    IF to_regclass(format('%I.profile_badges', target_schema)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS profile_badges_select_public ON %I.profile_badges', target_schema);
    END IF;

    IF to_regclass(format('%I.ingestion_runs', target_schema)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS ingestion_runs_select_own ON %I.ingestion_runs', target_schema);
    END IF;

    SELECT c.relkind
    INTO leaderboard_relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema
      AND c.relname = 'leaderboard_lifetime';

    IF leaderboard_relkind IN ('r', 'p') THEN
      EXECUTE format('DROP POLICY IF EXISTS leaderboard_lifetime_select_public ON %I.leaderboard_lifetime', target_schema);
    END IF;
  END LOOP;
END;
$$;

-- Phase 5: Verify integrity, wipe legacy badge data, and seed canonical badges.
DO $$
DECLARE
  dedup_constraint_exists boolean;
  total_tokens_generated text;
  target_schema text;
BEGIN
  FOR target_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname = COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public')
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.profiles', target_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    RAISE NOTICE '0010 sanity check target schema: %', target_schema;

    SELECT c.is_generated
    INTO total_tokens_generated
    FROM information_schema.columns c
    WHERE c.table_schema = target_schema
      AND c.table_name = 'sessions'
      AND c.column_name = 'total_tokens';

    IF total_tokens_generated IS DISTINCT FROM 'ALWAYS' THEN
      RAISE EXCEPTION '%.sessions.total_tokens must be GENERATED ALWAYS, found %', target_schema, total_tokens_generated;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = target_schema
        AND rel.relname = 'sessions'
        AND con.contype IN ('u', 'p')
        AND (
          SELECT array_agg(att.attname::text ORDER BY keys.ordinality)
          FROM unnest(con.conkey) WITH ORDINALITY AS keys(attnum, ordinality)
          JOIN pg_attribute att
            ON att.attrelid = con.conrelid
           AND att.attnum = keys.attnum
        ) = ARRAY['profile_id', 'source', 'session_id', 'file_sha256']::text[]
    )
    INTO dedup_constraint_exists;

    IF NOT dedup_constraint_exists THEN
      RAISE EXCEPTION '%.sessions is missing UNIQUE(profile_id, source, session_id, file_sha256)', target_schema;
    END IF;

    -- Wipe legacy badge taxonomy and legacy awards before reseeding the
    -- design-canon catalog. DELETE is intentionally used for idempotency.
    IF to_regclass(format('%I.profile_badges', target_schema)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I.profile_badges', target_schema);
    END IF;

    IF to_regclass(format('%I.badges', target_schema)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I.badges', target_schema);

      EXECUTE format(
        $sql$
          INSERT INTO %I.badges (
            slug,
            name,
            description,
            icon_slug,
            criteria_json,
            requires_verification,
            tier
          )
          VALUES
            (
              'tier',
              'Tier',
              'Top one percent token usage threshold: 25M lifetime tokens.',
              '◇',
              '{"threshold_tokens":25000000}'::jsonb,
              true,
              'legendary'
            ),
            (
              'iron_streak',
              'Iron Streak',
              '30+ consecutive days with recorded coding sessions.',
              '▮',
              '{"min_consecutive_days":30}'::jsonb,
              true,
              'rare'
            ),
            (
              'operator',
              'Operator',
              'Power-user cadence: 10 or more sessions per day on average.',
              '⌬',
              '{"min_sessions_per_day_avg":10}'::jsonb,
              true,
              'rare'
            ),
            (
              'cache_whisperer',
              'Cache Whisperer',
              'Cache-read tokens are more than 30 percent of total usage.',
              '◈',
              '{"min_cache_read_ratio":0.3}'::jsonb,
              true,
              'rare'
            ),
            (
              'night_owl',
              'Night Owl',
              'At least half of sessions land between 22:00 and 06:00.',
              '☾',
              '{"min_night_sessions_pct":0.5,"night_start_hour":22,"night_end_hour":6}'::jsonb,
              false,
              'standard'
            ),
            (
              'multi_provider',
              'Multi-Provider',
              'Uses both Claude and Codex.',
              '◫',
              '{"requires_claude":true,"requires_codex":true}'::jsonb,
              false,
              'standard'
            ),
            (
              'conductor',
              'Conductor',
              'Uses five or more distinct models.',
              '⬢',
              '{"min_models_used":5}'::jsonb,
              false,
              'rare'
            ),
            (
              'outage_witness',
              'Outage Witness',
              'Has a session tagged with a provider or API error.',
              '✦',
              '{"requires_error_tag":true}'::jsonb,
              false,
              'legendary'
            ),
            (
              'reasoning_junkie',
              'Reasoning Junkie',
              'Reasoning tokens are present and exceed 10 percent of total output.',
              '◯',
              '{"min_reasoning_tokens":1,"min_reasoning_ratio":0.1}'::jsonb,
              true,
              'rare'
            ),
            (
              'marathoner',
              'Marathoner',
              'Logged a single session longer than six hours.',
              '◢',
              '{"min_session_hours":6}'::jsonb,
              false,
              'standard'
            ),
            (
              'detonation',
              'Detonation',
              'Exceeded 10M total tokens in one UTC day.',
              '▲',
              '{"min_daily_tokens":10000000}'::jsonb,
              false,
              'rare'
            ),
            (
              'long_context',
              'Long-Context',
              'Worked with more than 100k context tokens.',
              '❒',
              '{"min_context_tokens":100000}'::jsonb,
              false,
              'standard'
            ),
            (
              'defection_arc',
              'Defection Arc',
              'Had a Claude phase and later switched to Codex.',
              '◐',
              '{"from_model":"claude","to_model":"codex"}'::jsonb,
              false,
              'standard'
            ),
            (
              'two_tool',
              'Two-Tool',
              'Uses both Claude and Codex in a balanced workflow.',
              '☰',
              '{"requires_both_models":true}'::jsonb,
              false,
              'standard'
            ),
            (
              'drifter',
              'Drifter',
              'Uses eight or more distinct models.',
              '◌',
              '{"min_models_used":8}'::jsonb,
              false,
              'standard'
            ),
            (
              'sniper',
              'Sniper',
              'At least 90 percent of usage is concentrated in one model.',
              '❖',
              '{"require_singular_focus":true,"focus_ratio_threshold":0.9}'::jsonb,
              false,
              'standard'
            )
          ON CONFLICT (slug) DO NOTHING
        $sql$,
        target_schema
      );
    END IF;
  END LOOP;
END;
$$;

-- Keep the live test-schema reset helper aligned with this reconciliation.
-- Older dev projects have a reset_test_schema() body that rebuilds worker
-- schemas with legacy mode constraints. Wrap it once, then reapply canonical
-- constraints after the legacy reset completes.
DO $$
BEGIN
  IF to_regprocedure('public.reset_test_schema(text)') IS NOT NULL
     AND to_regprocedure('public.reset_test_schema_legacy_0010(text)') IS NULL THEN
    ALTER FUNCTION public.reset_test_schema(text) RENAME TO reset_test_schema_legacy_0010;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_test_schema(schema_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF to_regprocedure('public.reset_test_schema_legacy_0010(text)') IS NULL THEN
    RAISE EXCEPTION 'reset_test_schema_legacy_0010(text) is required before applying canonical reset wrapper'
      USING ERRCODE = '42883';
  END IF;

  PERFORM public.reset_test_schema_legacy_0010(schema_name);

  EXECUTE format('ALTER TABLE %I.profiles DROP CONSTRAINT IF EXISTS profiles_mode_check', schema_name);
  EXECUTE format(
    'ALTER TABLE %I.profiles ADD CONSTRAINT profiles_mode_check CHECK (mode IS NULL OR mode IN (''script_verified'', ''self_reported''))',
    schema_name
  );

  IF to_regclass(format('%I.ingestion_runs', schema_name)) IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs DROP CONSTRAINT IF EXISTS ingestion_runs_ingestion_mode_check',
      schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs ADD CONSTRAINT ingestion_runs_ingestion_mode_check CHECK (ingestion_mode IN (''script_verified'', ''self_reported''))',
      schema_name
    );
  END IF;

  IF to_regclass(format('%I.sessions', schema_name)) IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE %I.sessions DROP CONSTRAINT IF EXISTS sessions_ingestion_mode_check',
      schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.sessions ADD CONSTRAINT sessions_ingestion_mode_check CHECK (ingestion_mode IN (''script_verified'', ''self_reported''))',
      schema_name
    );
  END IF;

  PERFORM pg_notify('pgrst', 'reload schema');
END;
$$;

COMMIT;
