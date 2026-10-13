-- Local-first publish aggregates.
--
-- The local app publishes compact aggregates, not raw transcript/event files.
-- GitHub-only shipped-code totals and AI-linked shipped-code claims are stored
-- separately so the server can enforce: AI-linked <= GitHub-only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.local_publish_runs (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id                 uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  github_user_id             bigint      NOT NULL,
  status                     text        NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  schema_version             integer     NOT NULL,
  client_version             text        NOT NULL,
  generated_at               timestamptz NOT NULL,
  started_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  usage_day_count            integer     NOT NULL DEFAULT 0 CHECK (usage_day_count >= 0),
  session_count              integer     NOT NULL DEFAULT 0 CHECK (session_count >= 0),
  github_code_day_count      integer     NOT NULL DEFAULT 0 CHECK (github_code_day_count >= 0),
  ai_linked_code_day_count   integer     NOT NULL DEFAULT 0 CHECK (ai_linked_code_day_count >= 0),
  remote_github_shipped_loc_total bigint  NOT NULL DEFAULT 0 CHECK (remote_github_shipped_loc_total >= 0),
  remote_github_commit_total integer      NOT NULL DEFAULT 0 CHECK (remote_github_commit_total >= 0),
  remote_github_day_count    integer      NOT NULL DEFAULT 0 CHECK (remote_github_day_count >= 0),
  remote_github_verified_at  timestamptz,
  summary                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  privacy_report             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error                      text
);

CREATE INDEX IF NOT EXISTS idx_local_publish_runs_profile_started
  ON public.local_publish_runs (profile_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.local_publish_links (
  code_hash                  text        PRIMARY KEY,
  profile_id                 uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  github_user_id             bigint      NOT NULL,
  publish_token_hash         text,
  expires_at                 timestamptz NOT NULL,
  exchanged_at               timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_local_publish_links_profile_created
  ON public.local_publish_links (profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_local_publish_links_token
  ON public.local_publish_links (publish_token_hash)
  WHERE publish_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.published_code_daily (
  profile_id                 uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date                       date        NOT NULL,
  produced_loc               bigint      NOT NULL DEFAULT 0 CHECK (produced_loc >= 0),
  ai_linked_commit_count     integer     NOT NULL DEFAULT 0 CHECK (ai_linked_commit_count >= 0),
  high_confidence_commit_count integer   NOT NULL DEFAULT 0 CHECK (high_confidence_commit_count >= 0),
  median_link_confidence     numeric     NOT NULL DEFAULT 0 CHECK (median_link_confidence >= 0 AND median_link_confidence <= 1),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, date)
);

CREATE INDEX IF NOT EXISTS idx_published_code_daily_profile_date
  ON public.published_code_daily (profile_id, date DESC);

CREATE TABLE IF NOT EXISTS public.local_published_github_code_daily (
  profile_id                 uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  publish_run_id             uuid        NOT NULL REFERENCES public.local_publish_runs(id) ON DELETE CASCADE,
  date                       date        NOT NULL,
  repo_id                    bigint      NOT NULL,
  full_name                  text        NOT NULL,
  prod_branch                text        NOT NULL,
  github_shipped_loc         bigint      NOT NULL DEFAULT 0 CHECK (github_shipped_loc >= 0),
  github_commit_count        integer     NOT NULL DEFAULT 0 CHECK (github_commit_count >= 0),
  verified_at                timestamptz NOT NULL,
  verification_source        text        NOT NULL CHECK (verification_source = 'github_remote_prod'),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, date, repo_id)
);

CREATE INDEX IF NOT EXISTS idx_local_published_github_code_daily_profile_date
  ON public.local_published_github_code_daily (profile_id, date DESC);

CREATE TABLE IF NOT EXISTS public.local_published_ai_linked_code_daily (
  profile_id                 uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  publish_run_id             uuid        NOT NULL REFERENCES public.local_publish_runs(id) ON DELETE CASCADE,
  date                       date        NOT NULL,
  repo_id                    bigint      NOT NULL,
  full_name                  text        NOT NULL,
  linked_shipped_loc         bigint      NOT NULL DEFAULT 0 CHECK (linked_shipped_loc >= 0),
  linked_commit_count        integer     NOT NULL DEFAULT 0 CHECK (linked_commit_count >= 0),
  linked_tokens              bigint      NOT NULL DEFAULT 0 CHECK (linked_tokens >= 0),
  high_confidence_commit_count integer   NOT NULL DEFAULT 0 CHECK (high_confidence_commit_count >= 0),
  median_link_confidence     numeric     NOT NULL DEFAULT 0 CHECK (median_link_confidence >= 0 AND median_link_confidence <= 1),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, date, repo_id)
);

CREATE INDEX IF NOT EXISTS idx_local_published_ai_linked_code_daily_profile_date
  ON public.local_published_ai_linked_code_daily (profile_id, date DESC);

ALTER TABLE public.local_publish_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.local_publish_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.published_code_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.local_published_github_code_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.local_published_ai_linked_code_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS local_publish_runs_owner_select ON public.local_publish_runs;
CREATE POLICY local_publish_runs_owner_select ON public.local_publish_runs
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS local_publish_links_owner_select ON public.local_publish_links;
CREATE POLICY local_publish_links_owner_select ON public.local_publish_links
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS published_code_daily_public_read ON public.published_code_daily;
CREATE POLICY published_code_daily_public_read ON public.published_code_daily
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS local_published_github_code_daily_public_read ON public.local_published_github_code_daily;
CREATE POLICY local_published_github_code_daily_public_read ON public.local_published_github_code_daily
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS local_published_ai_linked_code_daily_public_read ON public.local_published_ai_linked_code_daily;
CREATE POLICY local_published_ai_linked_code_daily_public_read ON public.local_published_ai_linked_code_daily
  FOR SELECT TO anon, authenticated USING (true);

DO $$
DECLARE
  target_schema text := COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public');
BEGIN
  IF target_schema = 'public' THEN
    RETURN;
  END IF;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', target_schema);

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS %I.local_publish_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      profile_id uuid NOT NULL REFERENCES %I.profiles(id) ON DELETE CASCADE,
      github_user_id bigint NOT NULL,
      status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
      schema_version integer NOT NULL,
      client_version text NOT NULL,
      generated_at timestamptz NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      usage_day_count integer NOT NULL DEFAULT 0 CHECK (usage_day_count >= 0),
      session_count integer NOT NULL DEFAULT 0 CHECK (session_count >= 0),
      github_code_day_count integer NOT NULL DEFAULT 0 CHECK (github_code_day_count >= 0),
      ai_linked_code_day_count integer NOT NULL DEFAULT 0 CHECK (ai_linked_code_day_count >= 0),
      remote_github_shipped_loc_total bigint NOT NULL DEFAULT 0 CHECK (remote_github_shipped_loc_total >= 0),
      remote_github_commit_total integer NOT NULL DEFAULT 0 CHECK (remote_github_commit_total >= 0),
      remote_github_day_count integer NOT NULL DEFAULT 0 CHECK (remote_github_day_count >= 0),
      remote_github_verified_at timestamptz,
      summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      privacy_report jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text
    )
  $sql$, target_schema, target_schema);

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS %I.local_published_github_code_daily (
      profile_id uuid NOT NULL REFERENCES %I.profiles(id) ON DELETE CASCADE,
      publish_run_id uuid NOT NULL REFERENCES %I.local_publish_runs(id) ON DELETE CASCADE,
      date date NOT NULL,
      repo_id bigint NOT NULL,
      full_name text NOT NULL,
      prod_branch text NOT NULL,
      github_shipped_loc bigint NOT NULL DEFAULT 0 CHECK (github_shipped_loc >= 0),
      github_commit_count integer NOT NULL DEFAULT 0 CHECK (github_commit_count >= 0),
      verified_at timestamptz NOT NULL,
      verification_source text NOT NULL CHECK (verification_source = 'github_remote_prod'),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, date, repo_id)
    )
  $sql$, target_schema, target_schema, target_schema);

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS %I.local_published_ai_linked_code_daily (
      profile_id uuid NOT NULL REFERENCES %I.profiles(id) ON DELETE CASCADE,
      publish_run_id uuid NOT NULL REFERENCES %I.local_publish_runs(id) ON DELETE CASCADE,
      date date NOT NULL,
      repo_id bigint NOT NULL,
      full_name text NOT NULL,
      linked_shipped_loc bigint NOT NULL DEFAULT 0 CHECK (linked_shipped_loc >= 0),
      linked_commit_count integer NOT NULL DEFAULT 0 CHECK (linked_commit_count >= 0),
      linked_tokens bigint NOT NULL DEFAULT 0 CHECK (linked_tokens >= 0),
      high_confidence_commit_count integer NOT NULL DEFAULT 0 CHECK (high_confidence_commit_count >= 0),
      median_link_confidence numeric NOT NULL DEFAULT 0 CHECK (median_link_confidence >= 0 AND median_link_confidence <= 1),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, date, repo_id)
    )
  $sql$, target_schema, target_schema, target_schema);

  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_local_publish_runs_profile_started ON %I.local_publish_runs (profile_id, started_at DESC)', target_schema);
  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS %I.local_publish_links (
      code_hash text PRIMARY KEY,
      profile_id uuid NOT NULL REFERENCES %I.profiles(id) ON DELETE CASCADE,
      github_user_id bigint NOT NULL,
      publish_token_hash text,
      expires_at timestamptz NOT NULL,
      exchanged_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  $sql$, target_schema, target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_local_publish_links_profile_created ON %I.local_publish_links (profile_id, created_at DESC)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_local_publish_links_token ON %I.local_publish_links (publish_token_hash) WHERE publish_token_hash IS NOT NULL', target_schema);
  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS %I.published_code_daily (
      profile_id uuid NOT NULL REFERENCES %I.profiles(id) ON DELETE CASCADE,
      date date NOT NULL,
      produced_loc bigint NOT NULL DEFAULT 0 CHECK (produced_loc >= 0),
      ai_linked_commit_count integer NOT NULL DEFAULT 0 CHECK (ai_linked_commit_count >= 0),
      high_confidence_commit_count integer NOT NULL DEFAULT 0 CHECK (high_confidence_commit_count >= 0),
      median_link_confidence numeric NOT NULL DEFAULT 0 CHECK (median_link_confidence >= 0 AND median_link_confidence <= 1),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, date)
    )
  $sql$, target_schema, target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_published_code_daily_profile_date ON %I.published_code_daily (profile_id, date DESC)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_local_published_github_code_daily_profile_date ON %I.local_published_github_code_daily (profile_id, date DESC)', target_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_local_published_ai_linked_code_daily_profile_date ON %I.local_published_ai_linked_code_daily (profile_id, date DESC)', target_schema);

  EXECUTE format('ALTER TABLE %I.local_publish_runs ENABLE ROW LEVEL SECURITY', target_schema);
  EXECUTE format('ALTER TABLE %I.local_publish_links ENABLE ROW LEVEL SECURITY', target_schema);
  EXECUTE format('ALTER TABLE %I.published_code_daily ENABLE ROW LEVEL SECURITY', target_schema);
  EXECUTE format('ALTER TABLE %I.local_published_github_code_daily ENABLE ROW LEVEL SECURITY', target_schema);
  EXECUTE format('ALTER TABLE %I.local_published_ai_linked_code_daily ENABLE ROW LEVEL SECURITY', target_schema);

  EXECUTE format('DROP POLICY IF EXISTS local_publish_runs_owner_select ON %I.local_publish_runs', target_schema);
  EXECUTE format(
    'CREATE POLICY local_publish_runs_owner_select ON %I.local_publish_runs FOR SELECT TO authenticated USING (profile_id IN (SELECT id FROM %I.profiles WHERE user_id = auth.uid()))',
    target_schema,
    target_schema
  );

  EXECUTE format('DROP POLICY IF EXISTS local_publish_links_owner_select ON %I.local_publish_links', target_schema);
  EXECUTE format(
    'CREATE POLICY local_publish_links_owner_select ON %I.local_publish_links FOR SELECT TO authenticated USING (profile_id IN (SELECT id FROM %I.profiles WHERE user_id = auth.uid()))',
    target_schema,
    target_schema
  );

  EXECUTE format('DROP POLICY IF EXISTS published_code_daily_public_read ON %I.published_code_daily', target_schema);
  EXECUTE format(
    'CREATE POLICY published_code_daily_public_read ON %I.published_code_daily FOR SELECT TO anon, authenticated USING (true)',
    target_schema
  );

  EXECUTE format('DROP POLICY IF EXISTS local_published_github_code_daily_public_read ON %I.local_published_github_code_daily', target_schema);
  EXECUTE format(
    'CREATE POLICY local_published_github_code_daily_public_read ON %I.local_published_github_code_daily FOR SELECT TO anon, authenticated USING (true)',
    target_schema
  );

  EXECUTE format('DROP POLICY IF EXISTS local_published_ai_linked_code_daily_public_read ON %I.local_published_ai_linked_code_daily', target_schema);
  EXECUTE format(
    'CREATE POLICY local_published_ai_linked_code_daily_public_read ON %I.local_published_ai_linked_code_daily FOR SELECT TO anon, authenticated USING (true)',
    target_schema
  );

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role, authenticator', target_schema);
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO anon, authenticated', target_schema);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO service_role', target_schema);

  PERFORM pg_notify('pgrst', 'reload schema');
END;
$$;

COMMIT;
