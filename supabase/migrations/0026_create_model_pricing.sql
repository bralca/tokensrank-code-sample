-- models.dev pricing cache: one row per (provider, model_id) with per-1M-token
-- rates, refreshed daily by the models-dev-sync cron. Reference data shared
-- across all profiles; the rebuild reads it to compute per-model API-equivalent
-- cost from the daily_aggregates token-type breakdown. `content_hash` lets the
-- sync skip unchanged rows. Rates are USD per 1,000,000 tokens (models.dev units).

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS public.model_pricing (
  provider             text        NOT NULL,
  model_id             text        NOT NULL,
  name                 text,
  family               text,
  input_per_mtok       numeric,
  output_per_mtok      numeric,
  cache_read_per_mtok  numeric,
  cache_write_per_mtok numeric,
  source_last_updated  text,
  content_hash         text        NOT NULL,
  fetched_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model_id)
);

-- Lookups by bare model id (fallback path when source→provider is ambiguous).
CREATE INDEX IF NOT EXISTS idx_model_pricing_model ON public.model_pricing (model_id);

-- Public reference data (like daily_aggregates). Service role bypasses RLS for
-- the sync cron; everyone may read.
ALTER TABLE public.model_pricing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS model_pricing_public_read ON public.model_pricing;
CREATE POLICY model_pricing_public_read ON public.model_pricing
  FOR SELECT TO anon, authenticated USING (true);

COMMIT;
