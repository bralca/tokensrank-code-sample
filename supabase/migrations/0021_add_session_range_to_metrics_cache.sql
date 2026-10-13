-- TokensRank Task: Add session range columns to profile_metrics_cache
-- Stores the actual first/last session timestamps so the frontend can display the true data range.

BEGIN TRANSACTION;

ALTER TABLE public.profile_metrics_cache
  ADD COLUMN IF NOT EXISTS first_session_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_session_at TIMESTAMPTZ;

COMMIT;
