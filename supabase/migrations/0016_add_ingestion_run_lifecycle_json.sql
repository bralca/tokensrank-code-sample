-- TokensRank Task 71.0: ingestion_runs lifecycle JSON columns.
--
-- The API continues to populate the legacy finished_at/error_summary fields used
-- by existing profile reads, while also writing the canonical lifecycle fields
-- required by FR-31.

BEGIN TRANSACTION;

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
    IF to_regclass(format('%I.ingestion_runs', target_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs ADD COLUMN IF NOT EXISTS completed_at timestamptz',
      target_schema
    );
    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs ADD COLUMN IF NOT EXISTS client_json jsonb NOT NULL DEFAULT ''{}''::jsonb',
      target_schema
    );
    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs ADD COLUMN IF NOT EXISTS run_json jsonb NOT NULL DEFAULT ''{}''::jsonb',
      target_schema
    );
    EXECUTE format(
      'ALTER TABLE %I.ingestion_runs ADD COLUMN IF NOT EXISTS rejected_details_json jsonb NOT NULL DEFAULT ''[]''::jsonb',
      target_schema
    );

    EXECUTE format(
      'UPDATE %I.ingestion_runs
         SET completed_at = COALESCE(completed_at, finished_at),
             client_json = COALESCE(client_json, ''{}''::jsonb),
             run_json = COALESCE(run_json, error_summary, ''{}''::jsonb),
             rejected_details_json = COALESCE(rejected_details_json, error_summary->''rejected_details'', ''[]''::jsonb)
       WHERE completed_at IS NULL
          OR client_json IS NULL
          OR run_json IS NULL
          OR rejected_details_json IS NULL',
      target_schema
    );
  END LOOP;
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
