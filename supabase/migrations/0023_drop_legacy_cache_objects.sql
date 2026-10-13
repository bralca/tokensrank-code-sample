-- 0023: Drop the legacy metrics cache layer.
--
-- Fully superseded by `profile_summary` (per-profile metrics + composite score)
-- and live queries (homepage stats from daily_aggregates; leaderboard ranks from
-- profile_summary with a query_leaderboard_ranked fallback). Every application
-- read of these objects was removed first (profile.ts loaders, homepage-stats
-- route, mv-refresh cron/service, leaderboard MV fallback), so these drops are
-- safe at runtime.

DROP MATERIALIZED VIEW IF EXISTS public.leaderboard_lifetime CASCADE;

DROP TABLE IF EXISTS public.profile_metrics_cache CASCADE;
DROP TABLE IF EXISTS public.profile_models_breakdown_cache CASCADE;
DROP TABLE IF EXISTS public.profile_tools_breakdown_cache CASCADE;
DROP TABLE IF EXISTS public.profile_sessions_cache CASCADE;
DROP TABLE IF EXISTS public.profile_cadence_cache CASCADE;
DROP TABLE IF EXISTS public.profile_projects_breakdown_cache CASCADE;
DROP TABLE IF EXISTS public.homepage_stats_cache CASCADE;
DROP TABLE IF EXISTS public.hourly_metrics_snapshots CASCADE;
