-- Model-level AI-coded and shipped-code aggregates from local publish.
--
-- These rows are compact, derived aggregates only. They contain no raw prompts,
-- commands, command output, file contents, or local paths.

BEGIN;

ALTER TABLE public.local_publish_runs
  ADD COLUMN IF NOT EXISTS model_code_day_count integer NOT NULL DEFAULT 0 CHECK (model_code_day_count >= 0);

CREATE TABLE IF NOT EXISTS public.local_published_model_code_daily (
  profile_id                 uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  publish_run_id             uuid        NOT NULL REFERENCES public.local_publish_runs(id) ON DELETE CASCADE,
  date                       date        NOT NULL,
  source                     text        NOT NULL CHECK (source IN ('claude', 'codex', 'opencode')),
  provider                   text        NOT NULL CHECK (provider IN ('anthropic', 'openai', 'unknown')),
  model                      text        NOT NULL,
  produced_loc               bigint      NOT NULL DEFAULT 0 CHECK (produced_loc >= 0),
  produced_loc_score         bigint      NOT NULL DEFAULT 0 CHECK (produced_loc_score >= 0),
  shipped_loc                bigint      NOT NULL DEFAULT 0 CHECK (shipped_loc >= 0),
  shipped_loc_score          bigint      NOT NULL DEFAULT 0 CHECK (shipped_loc_score >= 0),
  linked_commit_count        integer     NOT NULL DEFAULT 0 CHECK (linked_commit_count >= 0),
  linked_tokens              bigint      NOT NULL DEFAULT 0 CHECK (linked_tokens >= 0),
  linked_cost_usd            numeric     NOT NULL DEFAULT 0 CHECK (linked_cost_usd >= 0),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, date, source, model)
);

CREATE INDEX IF NOT EXISTS idx_local_published_model_code_daily_profile_date
  ON public.local_published_model_code_daily (profile_id, date DESC);

ALTER TABLE public.local_published_model_code_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS local_published_model_code_daily_public_read ON public.local_published_model_code_daily;
CREATE POLICY local_published_model_code_daily_public_read ON public.local_published_model_code_daily
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.local_published_model_code_daily TO anon, authenticated;
GRANT ALL PRIVILEGES ON public.local_published_model_code_daily TO service_role;

DO $$
DECLARE
  target_schema text := COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public');
BEGIN
  IF target_schema = 'public' THEN
    RETURN;
  END IF;

  EXECUTE format(
    'ALTER TABLE %I.local_publish_runs ADD COLUMN IF NOT EXISTS model_code_day_count integer NOT NULL DEFAULT 0 CHECK (model_code_day_count >= 0)',
    target_schema
  );

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS %I.local_published_model_code_daily (
      profile_id uuid NOT NULL REFERENCES %I.profiles(id) ON DELETE CASCADE,
      publish_run_id uuid NOT NULL REFERENCES %I.local_publish_runs(id) ON DELETE CASCADE,
      date date NOT NULL,
      source text NOT NULL CHECK (source IN ('claude', 'codex', 'opencode')),
      provider text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'unknown')),
      model text NOT NULL,
      produced_loc bigint NOT NULL DEFAULT 0 CHECK (produced_loc >= 0),
      produced_loc_score bigint NOT NULL DEFAULT 0 CHECK (produced_loc_score >= 0),
      shipped_loc bigint NOT NULL DEFAULT 0 CHECK (shipped_loc >= 0),
      shipped_loc_score bigint NOT NULL DEFAULT 0 CHECK (shipped_loc_score >= 0),
      linked_commit_count integer NOT NULL DEFAULT 0 CHECK (linked_commit_count >= 0),
      linked_tokens bigint NOT NULL DEFAULT 0 CHECK (linked_tokens >= 0),
      linked_cost_usd numeric NOT NULL DEFAULT 0 CHECK (linked_cost_usd >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, date, source, model)
    )
  $sql$, target_schema, target_schema, target_schema);

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_local_published_model_code_daily_profile_date ON %I.local_published_model_code_daily (profile_id, date DESC)',
    target_schema
  );
  EXECUTE format('ALTER TABLE %I.local_published_model_code_daily ENABLE ROW LEVEL SECURITY', target_schema);
  EXECUTE format('DROP POLICY IF EXISTS local_published_model_code_daily_public_read ON %I.local_published_model_code_daily', target_schema);
  EXECUTE format(
    'CREATE POLICY local_published_model_code_daily_public_read ON %I.local_published_model_code_daily FOR SELECT TO anon, authenticated USING (true)',
    target_schema
  );
  EXECUTE format('GRANT SELECT ON %I.local_published_model_code_daily TO anon, authenticated', target_schema);
  EXECUTE format('GRANT ALL PRIVILEGES ON %I.local_published_model_code_daily TO service_role', target_schema);
  PERFORM pg_notify('pgrst', 'reload schema');
END;
$$;

COMMIT;
