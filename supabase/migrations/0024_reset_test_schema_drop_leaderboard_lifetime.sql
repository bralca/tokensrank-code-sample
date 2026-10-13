-- 0024: rebuild reset_test_schema_legacy_0010 without the dropped leaderboard_lifetime
-- materialized view (test-schema infra; see 0023). Generated from the live def.

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
  execute format(
    'alter table %I.access_keys add column if not exists updated_at timestamptz not null default now()',
    schema_name
  );
  execute format(
    'alter table %I.sessions add column if not exists updated_at timestamptz not null default now()',
    schema_name
  );
  execute format(
    'alter table %I.badges add column if not exists updated_at timestamptz not null default now()',
    schema_name
  );
  execute format(
    'alter table %I.profile_badges add column if not exists updated_at timestamptz not null default now()',
    schema_name
  );

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
  execute format('alter table %I.badges enable row level security', schema_name);
  execute format('alter table %I.profile_badges enable row level security', schema_name);
  execute format('alter table %I.ingestion_runs enable row level security', schema_name);
  execute format('alter table %I.audit_events enable row level security', schema_name);

  execute format(
    'grant usage on schema %I to anon, authenticated, service_role, authenticator',
    schema_name
  );
  execute format('grant select on all tables in schema %I to anon, authenticated', schema_name);
  execute format('grant update on %I.profiles to authenticated', schema_name);
  execute format('grant update on %I.access_keys to authenticated', schema_name);
  execute format('grant all privileges on all tables in schema %I to service_role', schema_name);

  execute format('drop policy if exists "profiles_select_own" on %I.profiles', schema_name);
  execute format(
    'create policy "profiles_select_own" on %I.profiles for select using (auth.uid() = user_id)',
    schema_name
  );
  execute format('drop policy if exists "profiles_select_public" on %I.profiles', schema_name);
  execute format(
    'create policy "profiles_select_public" on %I.profiles for select using (handle is not null and mode is not null)',
    schema_name
  );
  execute format('drop policy if exists "profiles_update_own" on %I.profiles', schema_name);
  execute format(
    'create policy "profiles_update_own" on %I.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id)',
    schema_name
  );

  execute format('drop policy if exists "access_keys_select_own" on %I.access_keys', schema_name);
  execute format(
    'create policy "access_keys_select_own" on %I.access_keys for select using (exists (select 1 from %I.profiles where profiles.id = access_keys.profile_id and profiles.user_id = auth.uid()))',
    schema_name,
    schema_name
  );
  execute format('drop policy if exists "access_keys_update_own" on %I.access_keys', schema_name);
  execute format(
    'create policy "access_keys_update_own" on %I.access_keys for update using (exists (select 1 from %I.profiles where profiles.id = access_keys.profile_id and profiles.user_id = auth.uid())) with check (exists (select 1 from %I.profiles where profiles.id = access_keys.profile_id and profiles.user_id = auth.uid()))',
    schema_name,
    schema_name,
    schema_name
  );

  execute format('drop policy if exists "sessions_select_own" on %I.sessions', schema_name);
  execute format(
    'create policy "sessions_select_own" on %I.sessions for select using (exists (select 1 from %I.profiles where profiles.id = sessions.profile_id and profiles.user_id = auth.uid()))',
    schema_name,
    schema_name
  );

  execute format('drop policy if exists "daily_aggregates_select_own" on %I.daily_aggregates', schema_name);
  execute format(
    'create policy "daily_aggregates_select_own" on %I.daily_aggregates for select using (exists (select 1 from %I.profiles where profiles.id = daily_aggregates.profile_id and profiles.user_id = auth.uid()))',
    schema_name,
    schema_name
  );

  execute format('drop policy if exists "ingestion_runs_select_own" on %I.ingestion_runs', schema_name);
  execute format(
    'create policy "ingestion_runs_select_own" on %I.ingestion_runs for select using (exists (select 1 from %I.profiles where profiles.id = ingestion_runs.profile_id and profiles.user_id = auth.uid()))',
    schema_name,
    schema_name
  );
  execute format('drop policy if exists "ingestion_runs_select_admin" on %I.ingestion_runs', schema_name);
  execute format(
    'create policy "ingestion_runs_select_admin" on %I.ingestion_runs for select using (auth.jwt() ->> ''role'' = ''service_role'')',
    schema_name
  );

  execute format('drop policy if exists "badges_select_public" on %I.badges', schema_name);
  execute format('create policy "badges_select_public" on %I.badges for select using (true)', schema_name);

  execute format('drop policy if exists "profile_badges_select_public" on %I.profile_badges', schema_name);
  execute format(
    'create policy "profile_badges_select_public" on %I.profile_badges for select using (true)',
    schema_name
  );


  execute format('drop policy if exists "audit_events_select_admin" on %I.audit_events', schema_name);
  execute format(
    'create policy "audit_events_select_admin" on %I.audit_events for select using (auth.jwt() ->> ''role'' = ''service_role'')',
    schema_name
  );

  execute format('drop trigger if exists trg_on_session_inserted on %I.sessions', schema_name);
  execute format('drop trigger if exists on_sessions_insert on %I.sessions', schema_name);
  execute format(
    'create trigger on_sessions_insert after insert on %I.sessions referencing new table as new_sessions for each statement execute function public.upsert_daily_aggregates_on_sessions_insert()',
    schema_name
  );
  execute format('drop trigger if exists trg_profiles_touch on %I.profiles', schema_name);
  execute format('drop trigger if exists touch_updated_at_profiles on %I.profiles', schema_name);
  execute format(
    'create trigger touch_updated_at_profiles before update on %I.profiles for each row execute function public.touch_updated_at()',
    schema_name
  );
  execute format('drop trigger if exists touch_updated_at_access_keys on %I.access_keys', schema_name);
  execute format(
    'create trigger touch_updated_at_access_keys before update on %I.access_keys for each row execute function public.touch_updated_at()',
    schema_name
  );
  execute format('drop trigger if exists touch_updated_at_sessions on %I.sessions', schema_name);
  execute format(
    'create trigger touch_updated_at_sessions before update on %I.sessions for each row execute function public.touch_updated_at()',
    schema_name
  );
  execute format('drop trigger if exists touch_updated_at_badges on %I.badges', schema_name);
  execute format(
    'create trigger touch_updated_at_badges before update on %I.badges for each row execute function public.touch_updated_at()',
    schema_name
  );
  execute format('drop trigger if exists touch_updated_at_profile_badges on %I.profile_badges', schema_name);
  execute format(
    'create trigger touch_updated_at_profile_badges before update on %I.profile_badges for each row execute function public.touch_updated_at()',
    schema_name
  );
  execute format('drop trigger if exists touch_updated_at_daily_aggregates on %I.daily_aggregates', schema_name);
  execute format(
    'create trigger touch_updated_at_daily_aggregates before update on %I.daily_aggregates for each row execute function public.touch_updated_at()',
    schema_name
  );

  perform pg_notify('pgrst', 'reload schema');
end;
$function$
;
