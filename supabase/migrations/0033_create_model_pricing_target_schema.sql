-- Mirror model_pricing into the configured target schema.
--
-- Runtime Supabase clients read through SUPABASE_SCHEMA / tokensrank.target_schema,
-- so the pricing reference table must exist outside public as well.

BEGIN;

DO $$
DECLARE
  target_schema text := COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public');
BEGIN
  IF target_schema <> 'public' THEN
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', target_schema);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.model_pricing (LIKE public.model_pricing INCLUDING ALL)', target_schema);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_model_pricing_model ON %I.model_pricing (model_id)', target_schema);
    EXECUTE format('ALTER TABLE %I.model_pricing ENABLE ROW LEVEL SECURITY', target_schema);
    EXECUTE format('DROP POLICY IF EXISTS model_pricing_public_read ON %I.model_pricing', target_schema);
    EXECUTE format(
      'CREATE POLICY model_pricing_public_read ON %I.model_pricing FOR SELECT TO anon, authenticated USING (true)',
      target_schema
    );
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role, authenticator', target_schema);
    EXECUTE format('GRANT SELECT ON %I.model_pricing TO anon, authenticated', target_schema);
    EXECUTE format('GRANT ALL PRIVILEGES ON %I.model_pricing TO service_role', target_schema);

    EXECUTE format('INSERT INTO %I.model_pricing SELECT * FROM public.model_pricing ON CONFLICT DO NOTHING', target_schema);
  END IF;
END;
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
    'model_pricing',
    'usage_event_imports',
    'usage_daily_aggregates',
    'usage_session_rollups',
    'local_publish_runs',
    'local_publish_links',
    'published_code_daily',
    'local_published_github_code_daily',
    'local_published_ai_linked_code_daily',
    'profile_verification_trust'
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

  IF to_regclass('public.model_pricing') IS NOT NULL
    AND to_regclass(format('%I.model_pricing', schema_name)) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.model_pricing ENABLE ROW LEVEL SECURITY', schema_name);
    EXECUTE format('DROP POLICY IF EXISTS model_pricing_public_read ON %I.model_pricing', schema_name);
    EXECUTE format(
      'CREATE POLICY model_pricing_public_read ON %I.model_pricing FOR SELECT TO anon, authenticated USING (true)',
      schema_name
    );
    EXECUTE format('INSERT INTO %I.model_pricing SELECT * FROM public.model_pricing ON CONFLICT DO NOTHING', schema_name);
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role, authenticator', schema_name);
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO anon, authenticated', schema_name);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO service_role', schema_name);

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
