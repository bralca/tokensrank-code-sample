-- Canonical browser-import usage pipeline.
--
-- usage_events is the immutable source of truth for manually imported local
-- usage data. usage_daily_aggregates and usage_session_rollups are rebuildable
-- projections derived from those events.

BEGIN;

CREATE TABLE IF NOT EXISTS public.usage_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id            uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  import_run_id          uuid        REFERENCES public.ingestion_runs(id) ON DELETE SET NULL,

  event_id              text        NOT NULL,
  source                text        NOT NULL CHECK (source IN ('claude', 'codex')),
  provider              text        NOT NULL CHECK (provider IN ('anthropic', 'openai', 'unknown')),
  event_kind            text        NOT NULL,
  session_id            text        NOT NULL,
  source_event_id       text,
  event_at              timestamptz NOT NULL,
  model                 text        NOT NULL DEFAULT 'unknown',
  model_source          text        NOT NULL CHECK (model_source IN ('explicit', 'session_context', 'unknown')),

  input_tokens          bigint      NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         bigint      NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens     bigint      NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_create_tokens   bigint      NOT NULL DEFAULT 0 CHECK (cache_create_tokens >= 0),
  cached_tokens         bigint      NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  reasoning_tokens      bigint      NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  total_tokens          bigint      GENERATED ALWAYS AS (
    input_tokens + output_tokens + cache_read_tokens + cache_create_tokens
  ) STORED,

  source_file_hash      text        NOT NULL CHECK (source_file_hash ~ '^[a-f0-9]{64}$'),
  source_file_size      bigint      CHECK (source_file_size IS NULL OR source_file_size >= 0),
  line_number           integer     CHECK (line_number IS NULL OR line_number > 0),
  parser_version        text        NOT NULL,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (profile_id, event_id),
  CHECK (input_tokens + output_tokens + cache_read_tokens + cache_create_tokens > 0)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_profile_event_at
  ON public.usage_events (profile_id, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_profile_model_event_at
  ON public.usage_events (profile_id, model, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_import_run
  ON public.usage_events (import_run_id);

CREATE TABLE IF NOT EXISTS public.usage_source_files (
  profile_id            uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source                text        NOT NULL CHECK (source IN ('claude', 'codex')),
  source_file_hash      text        NOT NULL CHECK (source_file_hash ~ '^[a-f0-9]{64}$'),
  import_run_id          uuid        REFERENCES public.ingestion_runs(id) ON DELETE SET NULL,
  source_file_size      bigint      NOT NULL DEFAULT 0 CHECK (source_file_size >= 0),
  line_count            integer     NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  parsed_event_count    integer     NOT NULL DEFAULT 0 CHECK (parsed_event_count >= 0),
  ignored_line_count    integer     NOT NULL DEFAULT 0 CHECK (ignored_line_count >= 0),
  warning_count         integer     NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  parser_version        text        NOT NULL,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (profile_id, source, source_file_hash)
);

CREATE TABLE IF NOT EXISTS public.usage_session_rollups (
  profile_id            uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source                text        NOT NULL CHECK (source IN ('claude', 'codex')),
  provider              text        NOT NULL CHECK (provider IN ('anthropic', 'openai', 'unknown')),
  session_id            text        NOT NULL,
  model                 text        NOT NULL DEFAULT 'unknown',
  first_event_at        timestamptz NOT NULL,
  last_event_at         timestamptz NOT NULL,
  input_tokens          bigint      NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         bigint      NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens     bigint      NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_create_tokens   bigint      NOT NULL DEFAULT 0 CHECK (cache_create_tokens >= 0),
  cached_tokens         bigint      NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  reasoning_tokens      bigint      NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  total_tokens          bigint      NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  turns                 integer     NOT NULL DEFAULT 0 CHECK (turns >= 0),
  cost_usd_total        numeric(12,4) NOT NULL DEFAULT 0,
  source_file_hashes    text[]      NOT NULL DEFAULT ARRAY[]::text[],
  updated_at            timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (profile_id, source, session_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_session_rollups_profile_last_event
  ON public.usage_session_rollups (profile_id, last_event_at DESC);

CREATE TABLE IF NOT EXISTS public.usage_daily_aggregates (
  profile_id            uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date                  date        NOT NULL,
  source                text        NOT NULL CHECK (source IN ('claude', 'codex')),
  provider              text        NOT NULL CHECK (provider IN ('anthropic', 'openai', 'unknown')),
  model                 text        NOT NULL DEFAULT 'unknown',
  total_tokens          bigint      NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  input_tokens          bigint      NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         bigint      NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens     bigint      NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_create_tokens   bigint      NOT NULL DEFAULT 0 CHECK (cache_create_tokens >= 0),
  cached_tokens         bigint      NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  reasoning_tokens      bigint      NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  total_sessions        integer     NOT NULL DEFAULT 0 CHECK (total_sessions >= 0),
  event_count           integer     NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  cost_usd_total        numeric(12,4) NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (profile_id, date, source, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_aggregates_profile_date
  ON public.usage_daily_aggregates (profile_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_usage_daily_aggregates_date_source
  ON public.usage_daily_aggregates (date DESC, source);

ALTER TABLE public.usage_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_source_files     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_session_rollups  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_daily_aggregates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_events_owner_select ON public.usage_events;
CREATE POLICY usage_events_owner_select ON public.usage_events
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS usage_source_files_owner_select ON public.usage_source_files;
CREATE POLICY usage_source_files_owner_select ON public.usage_source_files
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS usage_session_rollups_owner_select ON public.usage_session_rollups;
CREATE POLICY usage_session_rollups_owner_select ON public.usage_session_rollups
  FOR SELECT TO authenticated
  USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS usage_daily_aggregates_public_read ON public.usage_daily_aggregates;
CREATE POLICY usage_daily_aggregates_public_read ON public.usage_daily_aggregates
  FOR SELECT TO anon, authenticated USING (true);

DO $$
DECLARE
  target_schema text := COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public');
BEGIN
  IF target_schema = 'public' THEN
    RETURN;
  END IF;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', target_schema);

  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.usage_events (LIKE public.usage_events INCLUDING ALL)', target_schema);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.usage_source_files (LIKE public.usage_source_files INCLUDING ALL)', target_schema);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.usage_session_rollups (LIKE public.usage_session_rollups INCLUDING ALL)', target_schema);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.usage_daily_aggregates (LIKE public.usage_daily_aggregates INCLUDING ALL)', target_schema);

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.usage_events (profile_id, event_at DESC)',
    'idx_usage_events_profile_event_at',
    target_schema
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.usage_events (profile_id, model, event_at DESC)',
    'idx_usage_events_profile_model_event_at',
    target_schema
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.usage_events (import_run_id)',
    'idx_usage_events_import_run',
    target_schema
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.usage_session_rollups (profile_id, last_event_at DESC)',
    'idx_usage_session_rollups_profile_last_event',
    target_schema
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.usage_daily_aggregates (profile_id, date DESC)',
    'idx_usage_daily_aggregates_profile_date',
    target_schema
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I.usage_daily_aggregates (date DESC, source)',
    'idx_usage_daily_aggregates_date_source',
    target_schema
  );

  EXECUTE format('ALTER TABLE %I.usage_events ENABLE ROW LEVEL SECURITY', target_schema);
  EXECUTE format('ALTER TABLE %I.usage_source_files ENABLE ROW LEVEL SECURITY', target_schema);
  EXECUTE format('ALTER TABLE %I.usage_session_rollups ENABLE ROW LEVEL SECURITY', target_schema);
  EXECUTE format('ALTER TABLE %I.usage_daily_aggregates ENABLE ROW LEVEL SECURITY', target_schema);

  EXECUTE format('DROP POLICY IF EXISTS usage_events_owner_select ON %I.usage_events', target_schema);
  EXECUTE format(
    'CREATE POLICY usage_events_owner_select ON %I.usage_events FOR SELECT TO authenticated USING (profile_id IN (SELECT id FROM %I.profiles WHERE user_id = auth.uid()))',
    target_schema,
    target_schema
  );

  EXECUTE format('DROP POLICY IF EXISTS usage_source_files_owner_select ON %I.usage_source_files', target_schema);
  EXECUTE format(
    'CREATE POLICY usage_source_files_owner_select ON %I.usage_source_files FOR SELECT TO authenticated USING (profile_id IN (SELECT id FROM %I.profiles WHERE user_id = auth.uid()))',
    target_schema,
    target_schema
  );

  EXECUTE format('DROP POLICY IF EXISTS usage_session_rollups_owner_select ON %I.usage_session_rollups', target_schema);
  EXECUTE format(
    'CREATE POLICY usage_session_rollups_owner_select ON %I.usage_session_rollups FOR SELECT TO authenticated USING (profile_id IN (SELECT id FROM %I.profiles WHERE user_id = auth.uid()))',
    target_schema,
    target_schema
  );

  EXECUTE format('DROP POLICY IF EXISTS usage_daily_aggregates_public_read ON %I.usage_daily_aggregates', target_schema);
  EXECUTE format(
    'CREATE POLICY usage_daily_aggregates_public_read ON %I.usage_daily_aggregates FOR SELECT TO anon, authenticated USING (true)',
    target_schema
  );

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role, authenticator', target_schema);
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO anon, authenticated', target_schema);
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO service_role', target_schema);

  PERFORM pg_notify('pgrst', 'reload schema');
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_test_schema_legacy_0010(schema_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  tables_to_truncate text[] := array[
    'profile_badges',
    'audit_events',
    'usage_events',
    'usage_source_files',
    'usage_session_rollups',
    'usage_daily_aggregates',
    'ingestion_runs',
    'access_keys',
    'sessions',
    'daily_aggregates',
    'badges',
    'profiles'
  ];
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'reset_test_schema is restricted to service-role callers'
      using errcode = '42501';
  end if;

  if schema_name !~ '^tokensrank_test_(w[0-9]+|qc_verify)$' then
    raise exception 'Invalid test schema name: %', schema_name
      using errcode = '22023';
  end if;

  execute format('create schema if not exists %I', schema_name);

  execute format('create table if not exists %I.profiles (like public.profiles including all)', schema_name);
  execute format('create table if not exists %I.access_keys (like public.access_keys including all)', schema_name);
  execute format('create table if not exists %I.sessions (like public.sessions including all)', schema_name);
  execute format('create table if not exists %I.daily_aggregates (like public.daily_aggregates including all)', schema_name);
  execute format('create table if not exists %I.usage_events (like public.usage_events including all)', schema_name);
  execute format('create table if not exists %I.usage_source_files (like public.usage_source_files including all)', schema_name);
  execute format('create table if not exists %I.usage_session_rollups (like public.usage_session_rollups including all)', schema_name);
  execute format('create table if not exists %I.usage_daily_aggregates (like public.usage_daily_aggregates including all)', schema_name);
  execute format('create table if not exists %I.badges (like public.badges including all)', schema_name);
  execute format('create table if not exists %I.profile_badges (like public.profile_badges including all)', schema_name);
  execute format('create table if not exists %I.ingestion_runs (like public.ingestion_runs including all)', schema_name);
  execute format('create table if not exists %I.audit_events (like public.audit_events including all)', schema_name);

  execute format('alter table %I.profiles alter column handle drop not null', schema_name);
  execute format('alter table %I.profiles alter column mode drop not null', schema_name);
  execute format('alter table %I.profiles alter column mode drop default', schema_name);
  execute format('alter table %I.profiles drop constraint if exists profiles_handle_check', schema_name);
  execute format(
    'alter table %I.profiles add constraint profiles_handle_check check (handle is null or (char_length(handle::text) between 3 and 30 and handle ~ ''^[a-z0-9_-]+$''::citext))',
    schema_name
  );
  execute format('alter table %I.profiles drop constraint if exists profiles_mode_check', schema_name);
  execute format(
    'alter table %I.profiles add constraint profiles_mode_check check (mode is null or mode = any (array[''A''::text, ''B''::text, ''script_verified''::text, ''self_reported''::text]))',
    schema_name
  );
  execute format('alter table %I.access_keys add column if not exists updated_at timestamptz not null default now()', schema_name);
  execute format('alter table %I.sessions add column if not exists updated_at timestamptz not null default now()', schema_name);
  execute format('alter table %I.badges add column if not exists updated_at timestamptz not null default now()', schema_name);
  execute format('alter table %I.profile_badges add column if not exists updated_at timestamptz not null default now()', schema_name);

  execute format(
    'truncate table %s restart identity cascade',
    array_to_string(
      array(
        select format('%I.%I', schema_name, table_name)
        from unnest(tables_to_truncate) as table_name
      ),
      ', '
    )
  );

  execute format('insert into %I.badges select * from public.badges on conflict do nothing', schema_name);

  execute format('alter table %I.profiles enable row level security', schema_name);
  execute format('alter table %I.access_keys enable row level security', schema_name);
  execute format('alter table %I.sessions enable row level security', schema_name);
  execute format('alter table %I.daily_aggregates enable row level security', schema_name);
  execute format('alter table %I.usage_events enable row level security', schema_name);
  execute format('alter table %I.usage_source_files enable row level security', schema_name);
  execute format('alter table %I.usage_session_rollups enable row level security', schema_name);
  execute format('alter table %I.usage_daily_aggregates enable row level security', schema_name);
  execute format('alter table %I.badges enable row level security', schema_name);
  execute format('alter table %I.profile_badges enable row level security', schema_name);
  execute format('alter table %I.ingestion_runs enable row level security', schema_name);
  execute format('alter table %I.audit_events enable row level security', schema_name);

  execute format('grant usage on schema %I to anon, authenticated, service_role, authenticator', schema_name);
  execute format('grant select on all tables in schema %I to anon, authenticated', schema_name);
  execute format('grant update on %I.profiles to authenticated', schema_name);
  execute format('grant update on %I.access_keys to authenticated', schema_name);
  execute format('grant all privileges on all tables in schema %I to service_role', schema_name);

  execute format('drop policy if exists "profiles_select_own" on %I.profiles', schema_name);
  execute format('create policy "profiles_select_own" on %I.profiles for select using (auth.uid() = user_id)', schema_name);
  execute format('drop policy if exists "profiles_select_public" on %I.profiles', schema_name);
  execute format('create policy "profiles_select_public" on %I.profiles for select using (handle is not null and mode is not null)', schema_name);
  execute format('drop policy if exists "profiles_update_own" on %I.profiles', schema_name);
  execute format('create policy "profiles_update_own" on %I.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', schema_name);

  execute format('drop policy if exists "access_keys_select_own" on %I.access_keys', schema_name);
  execute format('create policy "access_keys_select_own" on %I.access_keys for select using (exists (select 1 from %I.profiles where profiles.id = access_keys.profile_id and profiles.user_id = auth.uid()))', schema_name, schema_name);
  execute format('drop policy if exists "access_keys_update_own" on %I.access_keys', schema_name);
  execute format('create policy "access_keys_update_own" on %I.access_keys for update using (exists (select 1 from %I.profiles where profiles.id = access_keys.profile_id and profiles.user_id = auth.uid())) with check (exists (select 1 from %I.profiles where profiles.id = access_keys.profile_id and profiles.user_id = auth.uid()))', schema_name, schema_name, schema_name);

  execute format('drop policy if exists "sessions_select_own" on %I.sessions', schema_name);
  execute format('create policy "sessions_select_own" on %I.sessions for select using (exists (select 1 from %I.profiles where profiles.id = sessions.profile_id and profiles.user_id = auth.uid()))', schema_name, schema_name);

  execute format('drop policy if exists "daily_aggregates_select_own" on %I.daily_aggregates', schema_name);
  execute format('create policy "daily_aggregates_select_own" on %I.daily_aggregates for select using (exists (select 1 from %I.profiles where profiles.id = daily_aggregates.profile_id and profiles.user_id = auth.uid()))', schema_name, schema_name);

  execute format('drop policy if exists "usage_events_select_own" on %I.usage_events', schema_name);
  execute format('create policy "usage_events_select_own" on %I.usage_events for select using (exists (select 1 from %I.profiles where profiles.id = usage_events.profile_id and profiles.user_id = auth.uid()))', schema_name, schema_name);
  execute format('drop policy if exists "usage_source_files_select_own" on %I.usage_source_files', schema_name);
  execute format('create policy "usage_source_files_select_own" on %I.usage_source_files for select using (exists (select 1 from %I.profiles where profiles.id = usage_source_files.profile_id and profiles.user_id = auth.uid()))', schema_name, schema_name);
  execute format('drop policy if exists "usage_session_rollups_select_own" on %I.usage_session_rollups', schema_name);
  execute format('create policy "usage_session_rollups_select_own" on %I.usage_session_rollups for select using (exists (select 1 from %I.profiles where profiles.id = usage_session_rollups.profile_id and profiles.user_id = auth.uid()))', schema_name, schema_name);
  execute format('drop policy if exists "usage_daily_aggregates_public_read" on %I.usage_daily_aggregates', schema_name);
  execute format('create policy "usage_daily_aggregates_public_read" on %I.usage_daily_aggregates for select using (true)', schema_name);

  execute format('drop policy if exists "ingestion_runs_select_own" on %I.ingestion_runs', schema_name);
  execute format('create policy "ingestion_runs_select_own" on %I.ingestion_runs for select using (exists (select 1 from %I.profiles where profiles.id = ingestion_runs.profile_id and profiles.user_id = auth.uid()))', schema_name, schema_name);
  execute format('drop policy if exists "ingestion_runs_select_admin" on %I.ingestion_runs', schema_name);
  execute format('create policy "ingestion_runs_select_admin" on %I.ingestion_runs for select using (auth.jwt() ->> ''role'' = ''service_role'')', schema_name);

  execute format('drop policy if exists "badges_select_public" on %I.badges', schema_name);
  execute format('create policy "badges_select_public" on %I.badges for select using (true)', schema_name);
  execute format('drop policy if exists "profile_badges_select_public" on %I.profile_badges', schema_name);
  execute format('create policy "profile_badges_select_public" on %I.profile_badges for select using (true)', schema_name);
  execute format('drop policy if exists "audit_events_select_admin" on %I.audit_events', schema_name);
  execute format('create policy "audit_events_select_admin" on %I.audit_events for select using (auth.jwt() ->> ''role'' = ''service_role'')', schema_name);

  execute format('drop trigger if exists trg_on_session_inserted on %I.sessions', schema_name);
  execute format('drop trigger if exists on_sessions_insert on %I.sessions', schema_name);
  execute format('create trigger on_sessions_insert after insert on %I.sessions referencing new table as new_sessions for each statement execute function public.upsert_daily_aggregates_on_sessions_insert()', schema_name);
  execute format('drop trigger if exists trg_profiles_touch on %I.profiles', schema_name);
  execute format('drop trigger if exists touch_updated_at_profiles on %I.profiles', schema_name);
  execute format('create trigger touch_updated_at_profiles before update on %I.profiles for each row execute function public.touch_updated_at()', schema_name);
  execute format('drop trigger if exists touch_updated_at_access_keys on %I.access_keys', schema_name);
  execute format('create trigger touch_updated_at_access_keys before update on %I.access_keys for each row execute function public.touch_updated_at()', schema_name);
  execute format('drop trigger if exists touch_updated_at_sessions on %I.sessions', schema_name);
  execute format('create trigger touch_updated_at_sessions before update on %I.sessions for each row execute function public.touch_updated_at()', schema_name);
  execute format('drop trigger if exists touch_updated_at_badges on %I.badges', schema_name);
  execute format('create trigger touch_updated_at_badges before update on %I.badges for each row execute function public.touch_updated_at()', schema_name);
  execute format('drop trigger if exists touch_updated_at_profile_badges on %I.profile_badges', schema_name);
  execute format('create trigger touch_updated_at_profile_badges before update on %I.profile_badges for each row execute function public.touch_updated_at()', schema_name);
  execute format('drop trigger if exists touch_updated_at_daily_aggregates on %I.daily_aggregates', schema_name);
  execute format('create trigger touch_updated_at_daily_aggregates before update on %I.daily_aggregates for each row execute function public.touch_updated_at()', schema_name);

  perform pg_notify('pgrst', 'reload schema');
end;
$function$
;

COMMIT;
