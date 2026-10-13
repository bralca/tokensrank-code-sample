-- Add active-time columns to sessions: total active wall-clock seconds and the
-- longest uninterrupted stretch (computed at ingestion from event timestamps;
-- a gap > 30m ends a stretch). Nullable so rows ingested before this existed
-- fall back to the capped first→last span until re-ingested.
-- ADD COLUMN with no default is metadata-only in Postgres (no table rewrite).

BEGIN TRANSACTION;

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS active_seconds integer,
  ADD COLUMN IF NOT EXISTS longest_active_seconds integer;

COMMIT;
