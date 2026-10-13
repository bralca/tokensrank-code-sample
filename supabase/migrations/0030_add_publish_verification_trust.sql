-- Optimistic local publish verification and leaderboard trust state.
--
-- A local publish can be accepted quickly, then GitHub verification runs
-- asynchronously. Only verified canonical aggregates are used for ranking; failed
-- verification attempts deboost the profile until repeated failures hide it.

BEGIN;

ALTER TABLE public.local_publish_runs
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'processing', 'passed', 'failed', 'unavailable')),
  ADD COLUMN IF NOT EXISTS verification_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_attempt_count integer NOT NULL DEFAULT 0 CHECK (verification_attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS verification_violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS local_invariant_violations jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_local_publish_runs_verification_status
  ON public.local_publish_runs (verification_status, started_at DESC);

CREATE TABLE IF NOT EXISTS public.profile_verification_trust (
  profile_id                         uuid        PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  latest_publish_run_id              uuid        REFERENCES public.local_publish_runs(id) ON DELETE SET NULL,
  latest_verification_status         text        NOT NULL DEFAULT 'pending'
    CHECK (latest_verification_status IN ('pending', 'processing', 'passed', 'failed', 'unavailable')),
  failed_publish_count               integer     NOT NULL DEFAULT 0 CHECK (failed_publish_count >= 0),
  consecutive_failed_publish_count   integer     NOT NULL DEFAULT 0 CHECK (consecutive_failed_publish_count >= 0),
  deboost_multiplier                 numeric     NOT NULL DEFAULT 1 CHECK (deboost_multiplier >= 0 AND deboost_multiplier <= 1),
  rank_eligible                      boolean     NOT NULL DEFAULT false,
  leaderboard_hidden_at              timestamptz,
  last_verified_at                   timestamptz,
  last_failed_at                     timestamptz,
  failure_reasons                    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at                         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profile_verification_trust_rank
  ON public.profile_verification_trust (rank_eligible, deboost_multiplier DESC)
  WHERE leaderboard_hidden_at IS NULL;

ALTER TABLE public.profile_verification_trust ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profile_verification_trust_public_read ON public.profile_verification_trust;
CREATE POLICY profile_verification_trust_public_read ON public.profile_verification_trust
  FOR SELECT TO anon, authenticated USING (true);

DO $$
DECLARE
  target_schema text := COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public');
BEGIN
  IF target_schema = 'public' THEN
    RETURN;
  END IF;

  EXECUTE format($sql$
    ALTER TABLE %I.local_publish_runs
      ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending'
        CHECK (verification_status IN ('pending', 'processing', 'passed', 'failed', 'unavailable')),
      ADD COLUMN IF NOT EXISTS verification_started_at timestamptz,
      ADD COLUMN IF NOT EXISTS verification_completed_at timestamptz,
      ADD COLUMN IF NOT EXISTS verification_attempt_count integer NOT NULL DEFAULT 0 CHECK (verification_attempt_count >= 0),
      ADD COLUMN IF NOT EXISTS verification_violations jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS local_invariant_violations jsonb NOT NULL DEFAULT '[]'::jsonb
  $sql$, target_schema);

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_local_publish_runs_verification_status ON %I.local_publish_runs (verification_status, started_at DESC)',
    target_schema
  );

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS %I.profile_verification_trust (
      profile_id uuid PRIMARY KEY REFERENCES %I.profiles(id) ON DELETE CASCADE,
      latest_publish_run_id uuid REFERENCES %I.local_publish_runs(id) ON DELETE SET NULL,
      latest_verification_status text NOT NULL DEFAULT 'pending'
        CHECK (latest_verification_status IN ('pending', 'processing', 'passed', 'failed', 'unavailable')),
      failed_publish_count integer NOT NULL DEFAULT 0 CHECK (failed_publish_count >= 0),
      consecutive_failed_publish_count integer NOT NULL DEFAULT 0 CHECK (consecutive_failed_publish_count >= 0),
      deboost_multiplier numeric NOT NULL DEFAULT 1 CHECK (deboost_multiplier >= 0 AND deboost_multiplier <= 1),
      rank_eligible boolean NOT NULL DEFAULT false,
      leaderboard_hidden_at timestamptz,
      last_verified_at timestamptz,
      last_failed_at timestamptz,
      failure_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  $sql$, target_schema, target_schema, target_schema);

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_profile_verification_trust_rank ON %I.profile_verification_trust (rank_eligible, deboost_multiplier DESC) WHERE leaderboard_hidden_at IS NULL',
    target_schema
  );

  EXECUTE format('ALTER TABLE %I.profile_verification_trust ENABLE ROW LEVEL SECURITY', target_schema);
  EXECUTE format('DROP POLICY IF EXISTS profile_verification_trust_public_read ON %I.profile_verification_trust', target_schema);
  EXECUTE format(
    'CREATE POLICY profile_verification_trust_public_read ON %I.profile_verification_trust FOR SELECT TO anon, authenticated USING (true)',
    target_schema
  );
  EXECUTE format('GRANT SELECT ON %I.profile_verification_trust TO anon, authenticated', target_schema);
  EXECUTE format('GRANT ALL PRIVILEGES ON %I.profile_verification_trust TO service_role', target_schema);
END
$$;

NOTIFY pgrst, 'reload schema';

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

COMMIT;
