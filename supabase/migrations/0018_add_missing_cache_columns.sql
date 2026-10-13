-- TokensRank Task: Add missing cache columns for on-demand computations
-- These columns enable caching of computations that are currently done on-demand per request

BEGIN TRANSACTION;

-- 1. Add missing columns to profile_metrics_cache
ALTER TABLE public.profile_metrics_cache
ADD COLUMN IF NOT EXISTS peak_ever integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS peak_ever_date text,
ADD COLUMN IF NOT EXISTS peak_ever_time text,
ADD COLUMN IF NOT EXISTS peak_daily integer[] DEFAULT ARRAY[]::integer[],
ADD COLUMN IF NOT EXISTS busiest_hour text,
ADD COLUMN IF NOT EXISTS busiest_day_of_week text,
ADD COLUMN IF NOT EXISTS rank_30d_ago integer,
ADD COLUMN IF NOT EXISTS parallelism_buckets jsonb NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS longest_session_seconds integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS longest_session_date text,
ADD COLUMN IF NOT EXISTS largest_tokens_session_tokens bigint DEFAULT 0,
ADD COLUMN IF NOT EXISTS largest_tokens_session_date text,
ADD COLUMN IF NOT EXISTS most_expensive_session_cost_usd numeric(12,4) DEFAULT 0,
ADD COLUMN IF NOT EXISTS most_expensive_session_date text,
ADD COLUMN IF NOT EXISTS median_session_seconds integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS sessions_over_1h integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_session_time_seconds bigint DEFAULT 0,
ADD COLUMN IF NOT EXISTS cache_hit_rate numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS first_model_name text,
ADD COLUMN IF NOT EXISTS first_model_date text,
ADD COLUMN IF NOT EXISTS latest_model_name text,
ADD COLUMN IF NOT EXISTS latest_model_date text,
ADD COLUMN IF NOT EXISTS top_model_by_sessions text,
ADD COLUMN IF NOT EXISTS distinct_models integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS tool_both_days integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS tool_days_observed integer DEFAULT 0;

-- 2. Add model metadata needed by the profile page.
ALTER TABLE public.profile_models_breakdown_cache
ADD COLUMN IF NOT EXISTS sessions_count integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS cost_usd_total numeric(12,4) DEFAULT 0;

-- 3. Add Claude vs Codex metadata needed by the profile page.
ALTER TABLE public.profile_tools_breakdown_cache
ADD COLUMN IF NOT EXISTS cost_usd_claude numeric(12,4) DEFAULT 0,
ADD COLUMN IF NOT EXISTS cost_usd_codex numeric(12,4) DEFAULT 0,
ADD COLUMN IF NOT EXISTS claude_cost_pct numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS codex_cost_pct numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS claude_sessions integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS codex_sessions integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS both_days integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS days_observed integer DEFAULT 0;

-- 4. Add cadence rows and labels used directly by the profile page.
ALTER TABLE public.profile_cadence_cache
ADD COLUMN IF NOT EXISTS busiest_hour_of_day text,
ADD COLUMN IF NOT EXISTS busiest_day_of_week text,
ADD COLUMN IF NOT EXISTS busiest_hour text,
ADD COLUMN IF NOT EXISTS busiest_day text,
ADD COLUMN IF NOT EXISTS days jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 5. Project breakdown per profile/window. This is public only when profiles.share_projects is true.
CREATE TABLE IF NOT EXISTS public.profile_projects_breakdown_cache (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "window" text NOT NULL CHECK ("window" IN ('7d', '30d', 'all')),
  project_name text NOT NULL,
  tokens_total bigint NOT NULL DEFAULT 0,
  cost_usd_total numeric(12,4) NOT NULL DEFAULT 0,
  sessions_count integer NOT NULL DEFAULT 0,
  percentage numeric DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (profile_id, "window", project_name)
);

CREATE INDEX IF NOT EXISTS idx_projects_breakdown_profile_window
  ON public.profile_projects_breakdown_cache (profile_id, "window");

ALTER TABLE public.profile_projects_breakdown_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_breakdown_select ON public.profile_projects_breakdown_cache;
CREATE POLICY projects_breakdown_select ON public.profile_projects_breakdown_cache
  FOR SELECT TO anon, authenticated USING (true);

COMMIT;
