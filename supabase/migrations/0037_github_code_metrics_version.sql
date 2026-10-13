-- Keep existing evidence for audit, but recompute old partial commit caches.
DO $migration$
DECLARE s text;
BEGIN
  FOR s IN SELECT table_schema FROM information_schema.tables
    WHERE table_name = 'commit_cache' AND table_schema NOT IN ('pg_catalog','information_schema')
  LOOP
    EXECUTE format('ALTER TABLE %I.commit_cache ADD COLUMN IF NOT EXISTS metrics_version integer NOT NULL DEFAULT 1', s);
  END LOOP;
END $migration$;
