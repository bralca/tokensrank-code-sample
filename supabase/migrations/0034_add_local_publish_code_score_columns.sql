DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = 'published_code_daily'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format('ALTER TABLE %I.published_code_daily ADD COLUMN IF NOT EXISTS produced_loc_score bigint NOT NULL DEFAULT 0 CHECK (produced_loc_score >= 0)', schema_name);
    EXECUTE format('ALTER TABLE %I.published_code_daily ADD COLUMN IF NOT EXISTS shipped_loc bigint NOT NULL DEFAULT 0 CHECK (shipped_loc >= 0)', schema_name);
    EXECUTE format('ALTER TABLE %I.published_code_daily ADD COLUMN IF NOT EXISTS shipped_loc_score bigint NOT NULL DEFAULT 0 CHECK (shipped_loc_score >= 0)', schema_name);
  END LOOP;

  FOR schema_name IN
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = 'local_published_github_code_daily'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format('ALTER TABLE %I.local_published_github_code_daily ADD COLUMN IF NOT EXISTS github_shipped_loc_score bigint NOT NULL DEFAULT 0 CHECK (github_shipped_loc_score >= 0)', schema_name);
  END LOOP;

  FOR schema_name IN
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = 'local_published_ai_linked_code_daily'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format('ALTER TABLE %I.local_published_ai_linked_code_daily ADD COLUMN IF NOT EXISTS linked_shipped_loc_score bigint NOT NULL DEFAULT 0 CHECK (linked_shipped_loc_score >= 0)', schema_name);
  END LOOP;
END;
$$;
