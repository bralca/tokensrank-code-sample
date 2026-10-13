-- Store hosted/local pricing snapshot mismatches on local publish runs.
--
-- Pricing mismatches are audit warnings: they explain when local displayed costs
-- may not match hosted reference pricing. They are not GitHub verification
-- failures and do not by themselves deboost rank.

BEGIN;

ALTER TABLE public.local_publish_runs
  ADD COLUMN IF NOT EXISTS pricing_mismatches jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
DECLARE
  target_schema text := COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public');
BEGIN
  IF target_schema = 'public' THEN
    RETURN;
  END IF;

  EXECUTE format($sql$
    ALTER TABLE %I.local_publish_runs
      ADD COLUMN IF NOT EXISTS pricing_mismatches jsonb NOT NULL DEFAULT '[]'::jsonb
  $sql$, target_schema);
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
