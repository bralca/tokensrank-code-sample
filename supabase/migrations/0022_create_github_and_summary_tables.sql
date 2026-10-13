-- TokensRank — GitHub-corroborated ranking: new data model (additive).
-- Creates: github_identities, connected_repos, commit_cache, contrib_daily,
--          profile_summary. Enables pg_cron (tolerant). No drops here —
--          the 8 legacy cache tables + leaderboard_lifetime MV are dropped in a
--          later cutover migration once reads are repointed.

BEGIN;

-- pg_cron: enable if the role allows it; otherwise enable via the Supabase
-- dashboard. Wrapped so a privilege error never aborts the table creation.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not enabled via migration (enable in Supabase dashboard): %', SQLERRM;
END
$$;

-- 1. GitHub identity per profile (durable fields + provider token for the pull job).
--    Sensitive: provider_token. No public/anon read policy.
CREATE TABLE IF NOT EXISTS public.github_identities (
  profile_id          uuid          PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  github_user_id      bigint        NOT NULL UNIQUE,
  login               text          NOT NULL,
  verified_emails     text[]        NOT NULL DEFAULT ARRAY[]::text[],
  provider_token      text,
  account_created_at  timestamptz,
  followers           integer       NOT NULL DEFAULT 0,
  connected_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_identities_login ON public.github_identities (lower(login));

-- 2. Repos the user opted into, with the declared prod branch.
CREATE TABLE IF NOT EXISTS public.connected_repos (
  profile_id   uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  repo_id      bigint      NOT NULL,
  full_name    text        NOT NULL,
  prod_branch  text        NOT NULL,
  is_private   boolean     NOT NULL DEFAULT false,
  stars        integer     NOT NULL DEFAULT 0,
  enabled      boolean     NOT NULL DEFAULT true,
  added_at     timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, repo_id)
);

CREATE INDEX IF NOT EXISTS idx_connected_repos_profile ON public.connected_repos (profile_id) WHERE enabled;

-- 3. Immutable per-commit cache (non-doc additions), keyed by repo+sha. Never re-fetched.
CREATE TABLE IF NOT EXISTS public.commit_cache (
  repo_id           bigint      NOT NULL,
  sha               text        NOT NULL,
  author_login      text,
  committed_date    timestamptz NOT NULL,
  nondoc_additions  integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_commit_cache_repo_date ON public.commit_cache (repo_id, committed_date DESC);

-- 4. GitHub shipped-code daily series (mirror of daily_aggregates shape).
CREATE TABLE IF NOT EXISTS public.contrib_daily (
  profile_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day               date        NOT NULL,
  shipped_loc       bigint      NOT NULL DEFAULT 0,
  commit_count      integer     NOT NULL DEFAULT 0,
  weighted_shipped  numeric     NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, day)
);

CREATE INDEX IF NOT EXISTS idx_contrib_daily_day ON public.contrib_daily (day DESC);

-- 5. Presentation summary per profile per window. Replaces the 8 metrics cache
--    tables. Ranking scalars are columns; the rest of the display payload
--    (90d arrays, histograms, model/session breakdowns, streak bands) is JSONB.
CREATE TABLE IF NOT EXISTS public.profile_summary (
  profile_id          uuid          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "window"            text          NOT NULL CHECK ("window" IN ('24h', '7d', '30d', 'all')),

  score               numeric       NOT NULL DEFAULT 0,
  rank                integer,
  rank_delta          integer,
  total_ranked        integer,
  percentile          numeric,

  tokens_total        bigint        NOT NULL DEFAULT 0,
  cost_usd_total      numeric(12,4) NOT NULL DEFAULT 0,
  shipped_loc_total   bigint        NOT NULL DEFAULT 0,
  commit_count_total  integer       NOT NULL DEFAULT 0,
  sessions_count      integer       NOT NULL DEFAULT 0,
  days_active         integer       NOT NULL DEFAULT 0,

  metrics             jsonb         NOT NULL DEFAULT '{}'::jsonb,

  computed_at         timestamptz   NOT NULL DEFAULT now(),

  PRIMARY KEY (profile_id, "window")
);

-- Leaderboard ranking: order by score within a window.
CREATE INDEX IF NOT EXISTS idx_profile_summary_window_score
  ON public.profile_summary ("window", score DESC, profile_id);

-- Row-Level Security
ALTER TABLE public.github_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connected_repos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commit_cache      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contrib_daily     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_summary   ENABLE ROW LEVEL SECURITY;

-- github_identities: owner may read own row (NOT the token via app projection);
-- no anon read. Service role bypasses RLS for the pull job.
DROP POLICY IF EXISTS github_identities_owner_select ON public.github_identities;
CREATE POLICY github_identities_owner_select ON public.github_identities
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

-- connected_repos: owner read/write own selections; no anon read.
DROP POLICY IF EXISTS connected_repos_owner_select ON public.connected_repos;
CREATE POLICY connected_repos_owner_select ON public.connected_repos
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS connected_repos_owner_write ON public.connected_repos;
CREATE POLICY connected_repos_owner_write ON public.connected_repos
  FOR ALL TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()))
  WITH CHECK (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

-- commit_cache: internal only (service role). No anon/auth policy.

-- contrib_daily + profile_summary: public display data (like daily_aggregates / old cache tables).
DROP POLICY IF EXISTS contrib_daily_public_read ON public.contrib_daily;
CREATE POLICY contrib_daily_public_read ON public.contrib_daily
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS profile_summary_public_read ON public.profile_summary;
CREATE POLICY profile_summary_public_read ON public.profile_summary
  FOR SELECT TO anon, authenticated USING (true);

COMMIT;
