-- TokensRank Task: Extend metrics to 90-day windows with timezone support
-- Adds 90-day data arrays, timezone column, and new computed metrics for profile redesign

BEGIN TRANSACTION;

-- 1. Add timezone column to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'UTC' CHECK (timezone != '');

-- 2. Add 90-day metrics to profile_metrics_cache
ALTER TABLE public.profile_metrics_cache
ADD COLUMN IF NOT EXISTS daily_tokens_90d integer[] DEFAULT ARRAY[]::integer[],
ADD COLUMN IF NOT EXISTS daily_sessions_90d integer[] DEFAULT ARRAY[]::integer[],
ADD COLUMN IF NOT EXISTS daily_peak_concurrent_90d smallint[] DEFAULT ARRAY[]::smallint[],
ADD COLUMN IF NOT EXISTS streak_bands jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS dominant_model_per_day_90d text[] DEFAULT ARRAY[]::text[],
ADD COLUMN IF NOT EXISTS model_metrics_90d jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS tier_progression jsonb DEFAULT '{}'::jsonb;

-- 3. Verify cadence cache has required columns for timezone support
ALTER TABLE public.profile_cadence_cache
ADD COLUMN IF NOT EXISTS hourly_pattern_user_tz integer[] DEFAULT ARRAY[]::integer[],
ADD COLUMN IF NOT EXISTS daily_pattern_user_tz integer[] DEFAULT ARRAY[]::integer[];

COMMIT;
