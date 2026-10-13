-- TokensRank — Initial Schema
-- Creates: 8 tables, RLS policies, 3 trigger functions, all indexes,
--          1 materialized view, 1 seed of 16 design-canon badges.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid          NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  handle          citext        UNIQUE CHECK (
    handle IS NULL
    OR (char_length(handle::text) BETWEEN 3 AND 30
        AND handle ~ '^[a-z0-9_-]+$')
  ),
  display_name    text,
  avatar_url      text,
  bio             text,
  x_handle        text,
  mode            text          CHECK (
    mode IS NULL
    OR mode IN ('script_verified','self_reported')
  ),
  verified        boolean       NOT NULL DEFAULT false,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

-- Access keys table
CREATE TABLE IF NOT EXISTS public.access_keys (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  key_sha256      text          NOT NULL UNIQUE,
  key_prefix      text          NOT NULL,
  label           text,
  scope           text          NOT NULL DEFAULT 'script'
                                CHECK (scope IN ('script','self_reported')),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

-- Ingestion runs table
CREATE TABLE IF NOT EXISTS public.ingestion_runs (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id               uuid         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  started_at               timestamptz  NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  status                   text         NOT NULL DEFAULT 'processing'
                             CHECK (status IN ('processing','completed','partial','failed')),
  file_count               integer      NOT NULL DEFAULT 0,
  session_count            integer      NOT NULL DEFAULT 0,
  duplicate_count          integer      NOT NULL DEFAULT 0,
  rejected_count           integer      NOT NULL DEFAULT 0,
  source_first_event_at    timestamptz,
  source_last_event_at     timestamptz,
  ingestion_mode           text         NOT NULL CHECK (ingestion_mode IN ('script_verified','self_reported')),
  client_version           text,
  platform                 text,
  user_agent               text,
  ip_hash                  text,
  error_summary            jsonb
);

-- Sessions table (fact table)
CREATE TABLE IF NOT EXISTS public.sessions (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id            uuid         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source                text         NOT NULL CHECK (source IN ('claude','codex')),
  model                 text,
  session_id            text         NOT NULL,
  file_sha256           text         NOT NULL,
  file_size             integer,
  first_event_at        timestamptz  NOT NULL,
  last_event_at         timestamptz  NOT NULL,
  input_tokens          bigint       NOT NULL DEFAULT 0,
  output_tokens         bigint       NOT NULL DEFAULT 0,
  cache_read_tokens     bigint       NOT NULL DEFAULT 0,
  cache_create_tokens   bigint       NOT NULL DEFAULT 0,
  cached_tokens         bigint       NOT NULL DEFAULT 0,
  reasoning_tokens      bigint       NOT NULL DEFAULT 0,
  total_tokens          bigint       GENERATED ALWAYS AS
                          (input_tokens + output_tokens + cache_read_tokens
                           + cache_create_tokens + cached_tokens + reasoning_tokens) STORED,
  turns                 integer      NOT NULL DEFAULT 0,
  platform              text,
  ingestion_mode        text         NOT NULL CHECK (ingestion_mode IN ('script_verified','self_reported')),
  ingested_at           timestamptz  NOT NULL DEFAULT now(),
  ingestion_run_id      uuid         REFERENCES public.ingestion_runs(id) ON DELETE SET NULL,
  fingerprint           jsonb,
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT sessions_dedup UNIQUE (profile_id, source, session_id, file_sha256)
);

-- Daily aggregates table
CREATE TABLE IF NOT EXISTS public.daily_aggregates (
  profile_id          uuid          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date                date          NOT NULL,
  source              text          NOT NULL CHECK (source IN ('claude','codex')),
  model               text          NOT NULL DEFAULT 'unknown',
  total_tokens        bigint        NOT NULL DEFAULT 0,
  total_sessions      integer       NOT NULL DEFAULT 0,
  derived_cost_usd    numeric(12,4) NOT NULL DEFAULT 0,
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, date, source, model)
);

-- Badges catalog
CREATE TABLE IF NOT EXISTS public.badges (
  slug                    text         PRIMARY KEY,
  name                    text         NOT NULL,
  description             text         NOT NULL,
  icon_slug               text         NOT NULL,
  criteria_json           jsonb        NOT NULL,
  requires_verification   boolean      NOT NULL DEFAULT false,
  tier                    text         NOT NULL DEFAULT 'standard'
                            CHECK (tier IN ('standard','rare','legendary')),
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now()
);

-- Profile badges junction table
CREATE TABLE IF NOT EXISTS public.profile_badges (
  profile_id   uuid         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  badge_slug   text         NOT NULL REFERENCES public.badges(slug) ON DELETE CASCADE,
  awarded_at   timestamptz  NOT NULL DEFAULT now(),
  evidence     jsonb,
  revoked_at   timestamptz,
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, badge_slug)
);

-- Audit events table
CREATE TABLE IF NOT EXISTS public.audit_events (
  id           bigserial    PRIMARY KEY,
  profile_id   uuid         REFERENCES public.profiles(id) ON DELETE SET NULL,
  event_type   text         NOT NULL,
  severity     text         NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','warn','critical')),
  payload      jsonb        NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_profiles_handle_lower      ON public.profiles (lower(handle::text));
CREATE INDEX IF NOT EXISTS idx_profiles_verified_created  ON public.profiles (verified, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aggregates_profile_date    ON public.daily_aggregates (profile_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_aggregates_date_source     ON public.daily_aggregates (date DESC, source);
CREATE INDEX IF NOT EXISTS idx_sessions_profile_last_event ON public.sessions (profile_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_file_sha256        ON public.sessions (file_sha256);
CREATE INDEX IF NOT EXISTS idx_sessions_ingestion_run      ON public.sessions (ingestion_run_id);
CREATE INDEX IF NOT EXISTS idx_access_keys_sha     ON public.access_keys (key_sha256) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_access_keys_profile ON public.access_keys (profile_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_profile_started ON public.ingestion_runs (profile_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_profile_type_time ON public.audit_events (profile_id, event_type, created_at DESC);

-- Materialized view for leaderboard
DROP MATERIALIZED VIEW IF EXISTS public.leaderboard_lifetime CASCADE;
CREATE MATERIALIZED VIEW public.leaderboard_lifetime AS
  SELECT p.id              AS profile_id,
         p.handle,
         p.display_name,
         p.avatar_url,
         p.verified,
         p.mode,
         COALESCE(SUM(da.total_tokens), 0)       AS lifetime_tokens,
         COALESCE(SUM(da.total_sessions), 0)     AS lifetime_sessions,
         MAX(da.date)                            AS last_active_date
  FROM public.profiles p
  LEFT JOIN public.daily_aggregates da ON da.profile_id = p.id
  GROUP BY p.id, p.handle, p.display_name, p.avatar_url, p.verified, p.mode;

CREATE UNIQUE INDEX idx_lb_lifetime_profile ON public.leaderboard_lifetime (profile_id);
CREATE INDEX idx_lb_lifetime_sort ON public.leaderboard_lifetime
  (verified DESC, lifetime_tokens DESC, profile_id);

-- Trigger functions
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.handle_auth_users_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, extensions AS $$
DECLARE
  target_schema text := 'public';
BEGIN
  IF COALESCE(NEW.raw_user_meta_data, '{}'::jsonb) ? 'test_schema' THEN
    target_schema := NEW.raw_user_meta_data ->> 'test_schema';
  END IF;

  IF target_schema !~ '^(public|tokensrank_test_w[0-9]+|tokensrank_test_qc_verify)$' THEN
    RAISE EXCEPTION 'Invalid profile shell target schema: %', target_schema
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format(
    'INSERT INTO %I.profiles (id, user_id, handle, mode, verified, created_at, updated_at)
     VALUES ($1, $1, NULL, NULL, false, now(), now())
     ON CONFLICT (user_id) DO NOTHING',
    target_schema
  )
  USING NEW.id;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.upsert_daily_aggregates_on_sessions_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  aggregate_row record;
BEGIN
  FOR aggregate_row IN
    SELECT
      profile_id,
      (last_event_at AT TIME ZONE 'UTC')::date AS aggregate_date,
      source,
      COALESCE(model, 'unknown') AS model,
      SUM(
        COALESCE(
          total_tokens,
          input_tokens + output_tokens + cache_read_tokens + cache_create_tokens
            + cached_tokens + reasoning_tokens,
          0
        )
      )::bigint AS total_tokens,
      COUNT(*)::integer AS total_sessions
    FROM new_sessions
    GROUP BY profile_id, (last_event_at AT TIME ZONE 'UTC')::date, source, COALESCE(model, 'unknown')
  LOOP
    EXECUTE format(
      'INSERT INTO %I.daily_aggregates
        (profile_id, date, source, model, total_tokens, total_sessions, derived_cost_usd, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, now())
       ON CONFLICT (profile_id, date, source, model)
       DO UPDATE SET
         total_tokens   = %I.daily_aggregates.total_tokens   + EXCLUDED.total_tokens,
         total_sessions = %I.daily_aggregates.total_sessions + EXCLUDED.total_sessions,
         updated_at     = now()',
      tg_table_schema, tg_table_schema, tg_table_schema
    )
    USING
      aggregate_row.profile_id,
      aggregate_row.aggregate_date,
      aggregate_row.source,
      aggregate_row.model,
      aggregate_row.total_tokens,
      aggregate_row.total_sessions;
  END LOOP;

  RETURN NULL;
END $$;

-- Triggers
DROP TRIGGER IF EXISTS touch_updated_at_profiles ON public.profiles;
CREATE TRIGGER touch_updated_at_profiles
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS touch_updated_at_access_keys ON public.access_keys;
CREATE TRIGGER touch_updated_at_access_keys
  BEFORE UPDATE ON public.access_keys
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS touch_updated_at_sessions ON public.sessions;
CREATE TRIGGER touch_updated_at_sessions
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS touch_updated_at_daily_aggregates ON public.daily_aggregates;
CREATE TRIGGER touch_updated_at_daily_aggregates
  BEFORE UPDATE ON public.daily_aggregates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS touch_updated_at_badges ON public.badges;
CREATE TRIGGER touch_updated_at_badges
  BEFORE UPDATE ON public.badges
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS touch_updated_at_profile_badges ON public.profile_badges;
CREATE TRIGGER touch_updated_at_profile_badges
  BEFORE UPDATE ON public.profile_badges
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS on_auth_users_insert ON auth.users;
CREATE TRIGGER on_auth_users_insert
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_auth_users_insert();

DROP TRIGGER IF EXISTS on_sessions_insert ON public.sessions;
CREATE TRIGGER on_sessions_insert
  AFTER INSERT ON public.sessions
  REFERENCING NEW TABLE AS new_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION public.upsert_daily_aggregates_on_sessions_insert();

-- Row-Level Security
ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_aggregates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.badges            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_badges    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select_public ON public.profiles;
CREATE POLICY profiles_select_public ON public.profiles
  FOR SELECT
  USING (handle IS NOT NULL AND mode IS NOT NULL);

DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS access_keys_owner_select ON public.access_keys;
CREATE POLICY access_keys_owner_select ON public.access_keys
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS access_keys_owner_update ON public.access_keys;
CREATE POLICY access_keys_owner_update ON public.access_keys
  FOR UPDATE TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()))
  WITH CHECK (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS sessions_public_read ON public.sessions;
CREATE POLICY sessions_public_read ON public.sessions
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS aggregates_public_read ON public.daily_aggregates;
CREATE POLICY aggregates_public_read ON public.daily_aggregates
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS badges_public_read ON public.badges;
CREATE POLICY badges_public_read ON public.badges
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS profile_badges_public_read ON public.profile_badges;
CREATE POLICY profile_badges_public_read ON public.profile_badges
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS ingestion_runs_owner_select ON public.ingestion_runs;
CREATE POLICY ingestion_runs_owner_select ON public.ingestion_runs
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS ingestion_runs_select_admin ON public.ingestion_runs;
CREATE POLICY ingestion_runs_select_admin ON public.ingestion_runs
  FOR SELECT
  USING ((auth.jwt() ->> 'role') = 'service_role');

DROP POLICY IF EXISTS audit_events_select_admin ON public.audit_events;
CREATE POLICY audit_events_select_admin ON public.audit_events
  FOR SELECT
  USING ((auth.jwt() ->> 'role') = 'service_role');

-- Badge seed (16 design-canon badges)
INSERT INTO public.badges (slug, name, description, icon_slug, criteria_json, requires_verification, tier)
VALUES
  ('tier',                'Tier',                'Concentric-ring tier badge — surfaces the user''s ladder rank (Bronze → Diamond II).',                  '◇', '{"type":"tier_ring"}'::jsonb,                                                              false, 'standard'),
  ('iron_streak',         'Iron Streak',         'Long unbroken cadence — active across many consecutive days.',                                          '▮', '{"type":"daily_streak","days":30}'::jsonb,                                                 true,  'rare'),
  ('operator',            'Operator',            'High-volume sustained usage — the workhorse profile.',                                                  '⌬', '{"type":"lifetime_tokens","threshold":100000000}'::jsonb,                                  false, 'rare'),
  ('cache_whisperer',     'Cache Whisperer',     'Exceptional prompt-cache hit rate over the qualifying window.',                                         '◈', '{"type":"cache_hit_rate","threshold":0.9,"window_days":30}'::jsonb,                        true,  'rare'),
  ('night_owl',           'Night Owl',           'Significant share of sessions between 00:00 and 05:00 local time.',                                     '☾', '{"type":"hour_share","window":[0,5],"threshold":0.5}'::jsonb,                              false, 'standard'),
  ('multi_provider',      'Multi-Provider',      'Significant usage across both Claude and Codex within the window.',                                     '◫', '{"type":"both_sources_share","threshold":0.2,"window_days":30}'::jsonb,                    false, 'standard'),
  ('conductor',           'Conductor',           'High peak-concurrent-agent count — running many sessions in parallel.',                                  '⬢', '{"type":"peak_concurrency","threshold":5}'::jsonb,                                         true,  'rare'),
  ('outage_witness',      'Outage Witness',      'Active during a known provider outage window — captured the disruption in their data.',                 '✦', '{"type":"outage_witness"}'::jsonb,                                                         true,  'legendary'),
  ('reasoning_junkie',    'Reasoning Junkie',    'High share of reasoning tokens (Codex-side) over the window.',                                          '◯', '{"type":"reasoning_share","threshold":0.4,"window_days":30}'::jsonb,                       false, 'standard'),
  ('marathoner',          'Marathoner',          'Logged a session that crossed the marathon threshold (multi-hour, large token count).',                  '◢', '{"type":"single_session_tokens","threshold":500000}'::jsonb,                               false, 'standard'),
  ('detonation',          'Detonation',          'A single-day spike many multiples above the user''s rolling baseline.',                                  '▲', '{"type":"day_spike","multiplier":5}'::jsonb,                                               false, 'rare'),
  ('long_context',        'Long-Context',        'Repeatedly worked at the edge of the context window (cache-create heavy).',                              '❒', '{"type":"cache_create_share","threshold":0.3}'::jsonb,                                     false, 'standard'),
  ('defection_arc',       'Defection Arc',       'Major share-of-tokens swing between Claude and Codex over the window — switched primary tool.',         '◐', '{"type":"source_swing","threshold":0.4,"window_days":90}'::jsonb,                          false, 'standard'),
  ('two_tool',            'Two-Tool',            '90/10-or-better split between two tools sustained — comfortable in both ecosystems.',                    '☰', '{"type":"both_sources_share","threshold":0.1,"window_days":90}'::jsonb,                    false, 'standard'),
  ('drifter',             'Drifter',             'Frequently jumped between models within sessions — exploratory pattern.',                                '◌', '{"type":"model_switch_rate","threshold":0.3}'::jsonb,                                      false, 'standard'),
  ('sniper',              'Sniper',              'Many short, low-token sessions — surgical, targeted prompts.',                                           '❖', '{"type":"short_session_share","threshold":0.5,"max_session_tokens":2000}'::jsonb,          false, 'standard')
ON CONFLICT (slug) DO NOTHING;
