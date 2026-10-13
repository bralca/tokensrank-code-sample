-- TokensRank Task: Create metrics cache tables for hourly pre-computed data
-- These tables store pre-computed metrics refreshed hourly instead of on-demand

BEGIN TRANSACTION;

-- 1. Profile metrics cache (main metrics per profile per window)
CREATE TABLE IF NOT EXISTS public.profile_metrics_cache (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "window" text NOT NULL CHECK ("window" IN ('7d', '30d', 'all')),

  -- All-time metrics (constant across windows)
  rank integer,
  percentile numeric,
  total_ranked integer,

  -- Window-specific metrics
  tokens_total bigint NOT NULL DEFAULT 0,
  cost_usd_total numeric(12,4) NOT NULL DEFAULT 0,
  sessions_count integer NOT NULL DEFAULT 0,
  days_active integer NOT NULL DEFAULT 0,
  avg_tokens_per_session numeric DEFAULT 0,

  -- Streaks (window-specific)
  current_streak integer DEFAULT 0,
  longest_streak integer DEFAULT 0,

  -- Activity patterns (window-specific)
  after_midnight_count integer DEFAULT 0,
  after_midnight_pct numeric DEFAULT 0,
  weekend_share numeric DEFAULT 0,

  -- Parallelism (window-specific)
  avg_concurrent numeric DEFAULT 0,
  days_parallel_3 integer DEFAULT 0,
  longest_sustained_3_seconds integer DEFAULT 0,

  -- Metadata
  computed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),

  PRIMARY KEY (profile_id, "window")
);

CREATE INDEX IF NOT EXISTS idx_profile_metrics_cache_expires ON public.profile_metrics_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_profile_metrics_cache_computed ON public.profile_metrics_cache (profile_id, computed_at DESC);

-- 2. Models breakdown per window
CREATE TABLE IF NOT EXISTS public.profile_models_breakdown_cache (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "window" text NOT NULL CHECK ("window" IN ('7d', '30d', 'all')),
  model text NOT NULL,

  tokens_total bigint NOT NULL DEFAULT 0,
  cost_usd numeric(12,4) NOT NULL DEFAULT 0,
  pct_of_total numeric DEFAULT 0,

  computed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (profile_id, "window", model)
);

CREATE INDEX IF NOT EXISTS idx_models_breakdown_profile_window ON public.profile_models_breakdown_cache (profile_id, "window");

-- 3. Tools breakdown (Claude vs Codex) per window
CREATE TABLE IF NOT EXISTS public.profile_tools_breakdown_cache (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "window" text NOT NULL CHECK ("window" IN ('7d', '30d', 'all')),

  claude_tokens bigint NOT NULL DEFAULT 0,
  codex_tokens bigint NOT NULL DEFAULT 0,
  claude_pct numeric DEFAULT 0,
  codex_pct numeric DEFAULT 0,

  computed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (profile_id, "window")
);

CREATE INDEX IF NOT EXISTS idx_tools_breakdown_profile_window ON public.profile_tools_breakdown_cache (profile_id, "window");

-- 4. Recent sessions cache (top 10 per window)
CREATE TABLE IF NOT EXISTS public.profile_sessions_cache (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "window" text NOT NULL CHECK ("window" IN ('7d', '30d', 'all')),
  session_rank integer NOT NULL CHECK (session_rank BETWEEN 1 AND 10),

  session_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('claude', 'codex')),
  model text,
  started_at timestamptz,
  ended_at timestamptz,
  tokens_total bigint NOT NULL DEFAULT 0,
  cost_usd_total numeric(12,4) NOT NULL DEFAULT 0,
  turns integer DEFAULT 0,
  project_name text,

  computed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (profile_id, "window", session_rank)
);

CREATE INDEX IF NOT EXISTS idx_sessions_cache_profile_window ON public.profile_sessions_cache (profile_id, "window");

-- 5. Cadence patterns (hourly and daily distribution) per window
CREATE TABLE IF NOT EXISTS public.profile_cadence_cache (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "window" text NOT NULL CHECK ("window" IN ('7d', '30d', 'all')),

  -- 24-element array: sessions count per hour (0-23)
  hourly_pattern integer[] NOT NULL DEFAULT ARRAY[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],

  -- 7-element array: sessions count per day (0=Sunday, 6=Saturday)
  daily_pattern integer[] NOT NULL DEFAULT ARRAY[0,0,0,0,0,0,0],

  computed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (profile_id, "window")
);

CREATE INDEX IF NOT EXISTS idx_cadence_cache_profile_window ON public.profile_cadence_cache (profile_id, "window");

-- 6. Homepage stats cache (24h pre-computed data)
CREATE TABLE IF NOT EXISTS public.homepage_stats_cache (
  id integer PRIMARY KEY DEFAULT 1,

  -- 24h stats from leaderboard
  connected_count integer NOT NULL DEFAULT 0,
  tokens_24h bigint NOT NULL DEFAULT 0,
  cost_24h_usd numeric(12,4) NOT NULL DEFAULT 0,
  records_today integer NOT NULL DEFAULT 0,

  computed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),

  CONSTRAINT homepage_stats_single_row CHECK (id = 1)
);

CREATE INDEX IF NOT EXISTS idx_homepage_stats_computed ON public.homepage_stats_cache (computed_at DESC);

-- 7. Hourly metrics snapshots (immutable history for trend analysis)
CREATE TABLE IF NOT EXISTS public.hourly_metrics_snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  "window" text NOT NULL CHECK ("window" IN ('7d', '30d', 'all')),
  snapshot_hour timestamptz NOT NULL,

  -- Metrics at this snapshot
  rank integer,
  percentile numeric,
  total_ranked integer,
  tokens_total bigint NOT NULL DEFAULT 0,
  sessions_count integer NOT NULL DEFAULT 0,
  days_active integer NOT NULL DEFAULT 0,

  -- Deltas (change from 1 hour ago)
  tokens_delta_1h bigint DEFAULT 0,
  sessions_delta_1h integer DEFAULT 0,
  rank_delta_1h integer DEFAULT 0,

  computed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hourly_snapshots_one_per_hour UNIQUE (profile_id, "window", snapshot_hour)
);

CREATE INDEX IF NOT EXISTS idx_hourly_snapshots_profile_window ON public.hourly_metrics_snapshots (profile_id, "window", snapshot_hour DESC);
CREATE INDEX IF NOT EXISTS idx_hourly_snapshots_window_time ON public.hourly_metrics_snapshots ("window", snapshot_hour DESC);

-- Enable RLS
ALTER TABLE public.profile_metrics_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_models_breakdown_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_tools_breakdown_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_sessions_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_cadence_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homepage_stats_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hourly_metrics_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS Policies (all read-public for profiles, snapshots, stats; sensitive data filtered in app)
DROP POLICY IF EXISTS metrics_cache_select ON public.profile_metrics_cache;
CREATE POLICY metrics_cache_select ON public.profile_metrics_cache
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS models_breakdown_select ON public.profile_models_breakdown_cache;
CREATE POLICY models_breakdown_select ON public.profile_models_breakdown_cache
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS tools_breakdown_select ON public.profile_tools_breakdown_cache;
CREATE POLICY tools_breakdown_select ON public.profile_tools_breakdown_cache
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS sessions_cache_select ON public.profile_sessions_cache;
CREATE POLICY sessions_cache_select ON public.profile_sessions_cache
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS cadence_cache_select ON public.profile_cadence_cache;
CREATE POLICY cadence_cache_select ON public.profile_cadence_cache
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS homepage_stats_select ON public.homepage_stats_cache;
CREATE POLICY homepage_stats_select ON public.homepage_stats_cache
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS hourly_snapshots_select ON public.hourly_metrics_snapshots;
CREATE POLICY hourly_snapshots_select ON public.hourly_metrics_snapshots
  FOR SELECT TO anon, authenticated USING (true);

COMMIT;
