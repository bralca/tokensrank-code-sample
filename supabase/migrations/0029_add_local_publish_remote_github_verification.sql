-- Add hosted GitHub verification rollup fields to local publish runs.
-- These are the server-calculated GitHub totals used to verify local claims.

BEGIN;

ALTER TABLE public.local_publish_runs
  ADD COLUMN IF NOT EXISTS remote_github_shipped_loc_total bigint NOT NULL DEFAULT 0 CHECK (remote_github_shipped_loc_total >= 0),
  ADD COLUMN IF NOT EXISTS remote_github_commit_total integer NOT NULL DEFAULT 0 CHECK (remote_github_commit_total >= 0),
  ADD COLUMN IF NOT EXISTS remote_github_day_count integer NOT NULL DEFAULT 0 CHECK (remote_github_day_count >= 0),
  ADD COLUMN IF NOT EXISTS remote_github_verified_at timestamptz;

DO $$
DECLARE
  target_schema text := COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public');
BEGIN
  IF target_schema = 'public' THEN
    RETURN;
  END IF;

  EXECUTE format($sql$
    ALTER TABLE %I.local_publish_runs
      ADD COLUMN IF NOT EXISTS remote_github_shipped_loc_total bigint NOT NULL DEFAULT 0 CHECK (remote_github_shipped_loc_total >= 0),
      ADD COLUMN IF NOT EXISTS remote_github_commit_total integer NOT NULL DEFAULT 0 CHECK (remote_github_commit_total >= 0),
      ADD COLUMN IF NOT EXISTS remote_github_day_count integer NOT NULL DEFAULT 0 CHECK (remote_github_day_count >= 0),
      ADD COLUMN IF NOT EXISTS remote_github_verified_at timestamptz
  $sql$, target_schema);
END
$$;

CREATE OR REPLACE FUNCTION public.reset_test_schema(schema_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  local_table text;
  local_tables text[] := ARRAY[
    'github_identities',
    'connected_repos',
    'commit_cache',
    'contrib_daily',
    'profile_summary',
    'usage_event_imports',
    'usage_daily_aggregates',
    'usage_session_rollups',
    'local_publish_runs',
    'local_publish_links',
    'published_code_daily',
    'local_published_github_code_daily',
    'local_published_ai_linked_code_daily'
  ];
BEGIN
  IF to_regprocedure('public.reset_test_schema_legacy_0010(text)') IS NULL THEN
    RAISE EXCEPTION 'reset_test_schema_legacy_0010(text) is required before applying canonical reset wrapper'
      USING ERRCODE = '42883';
  END IF;

  PERFORM public.reset_test_schema_legacy_0010(schema_name);

  FOREACH local_table IN ARRAY local_tables LOOP
    IF to_regclass(format('public.%I', local_table)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.%I (LIKE public.%I INCLUDING ALL)',
        schema_name,
        local_table,
        local_table
      );
      EXECUTE format('TRUNCATE TABLE %I.%I RESTART IDENTITY CASCADE', schema_name, local_table);
    END IF;
  END LOOP;

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
    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs ADD COLUMN IF NOT EXISTS completed_at timestamptz',
      schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs ADD COLUMN IF NOT EXISTS client_json jsonb NOT NULL DEFAULT ''{}''::jsonb',
      schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs ADD COLUMN IF NOT EXISTS run_json jsonb NOT NULL DEFAULT ''{}''::jsonb',
      schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs ADD COLUMN IF NOT EXISTS rejected_details_json jsonb NOT NULL DEFAULT ''[]''::jsonb',
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

NOTIFY pgrst, 'reload schema';

COMMIT;
