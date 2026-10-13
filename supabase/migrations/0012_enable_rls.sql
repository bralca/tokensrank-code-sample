-- TokensRank Task 6.0: define and enable canonical RLS policies on all 8 tables.
--
-- Live Dev RLS audit before this migration:
-- - profiles: RLS enabled, 3 policies
-- - access_keys: RLS enabled, 2 policies
-- - sessions: RLS enabled, 1 policy
-- - daily_aggregates: RLS enabled, 1 policy
-- - badges: RLS enabled, 1 policy
-- - profile_badges: RLS enabled, 1 policy
-- - ingestion_runs: RLS enabled, 2 policies
-- - audit_events: RLS enabled, 1 policy
--
-- All 8 production tables already had RLS enabled in Dev, but the policy set
-- was not the complete NFR-10 / Blueprint §13.5.1 matrix.

BEGIN TRANSACTION;

DO $$
DECLARE
  target_schema text;
BEGIN
  FOR target_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname = COALESCE(NULLIF(current_setting('tokensrank.target_schema', true), ''), 'public')
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.profiles', target_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I.profiles ENABLE ROW LEVEL SECURITY', target_schema);

    EXECUTE format('DROP POLICY IF EXISTS profiles_select_public ON %I.profiles', target_schema);
    EXECUTE format('DROP POLICY IF EXISTS profiles_select_own ON %I.profiles', target_schema);
    EXECUTE format('DROP POLICY IF EXISTS profiles_update_own ON %I.profiles', target_schema);
    EXECUTE format('DROP POLICY IF EXISTS profiles_delete_own ON %I.profiles', target_schema);

    EXECUTE format(
      $sql$
        CREATE POLICY profiles_select_public ON %I.profiles
          FOR SELECT
          USING (
            auth.uid() = user_id
            OR (handle IS NOT NULL AND mode IS NOT NULL)
          )
      $sql$,
      target_schema
    );

    EXECUTE format(
      $sql$
        CREATE POLICY profiles_update_own ON %I.profiles
          FOR UPDATE
          USING (auth.uid() = user_id)
          WITH CHECK (auth.uid() = user_id)
      $sql$,
      target_schema
    );

    EXECUTE format(
      $sql$
        CREATE POLICY profiles_delete_own ON %I.profiles
          FOR DELETE
          USING (auth.uid() = user_id)
      $sql$,
      target_schema
    );

    IF to_regclass(format('%I.access_keys', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.access_keys ENABLE ROW LEVEL SECURITY', target_schema);

      EXECUTE format('DROP POLICY IF EXISTS access_keys_owner_select ON %I.access_keys', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS access_keys_owner_update ON %I.access_keys', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS access_keys_select_own ON %I.access_keys', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS access_keys_insert_own ON %I.access_keys', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS access_keys_update_own ON %I.access_keys', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS access_keys_delete_own ON %I.access_keys', target_schema);

      EXECUTE format(
        $sql$
          CREATE POLICY access_keys_select_own ON %I.access_keys
            FOR SELECT TO authenticated
            USING (
              EXISTS (
                SELECT 1
                FROM %I.profiles owner_profile
                WHERE owner_profile.id = access_keys.profile_id
                  AND owner_profile.user_id = auth.uid()
              )
            )
        $sql$,
        target_schema,
        target_schema
      );

      EXECUTE format(
        $sql$
          CREATE POLICY access_keys_insert_own ON %I.access_keys
            FOR INSERT TO authenticated
            WITH CHECK (
              EXISTS (
                SELECT 1
                FROM %I.profiles owner_profile
                WHERE owner_profile.id = access_keys.profile_id
                  AND owner_profile.user_id = auth.uid()
              )
            )
        $sql$,
        target_schema,
        target_schema
      );

      EXECUTE format(
        $sql$
          CREATE POLICY access_keys_delete_own ON %I.access_keys
            FOR DELETE TO authenticated
            USING (
              EXISTS (
                SELECT 1
                FROM %I.profiles owner_profile
                WHERE owner_profile.id = access_keys.profile_id
                  AND owner_profile.user_id = auth.uid()
              )
            )
        $sql$,
        target_schema,
        target_schema
      );
    END IF;

    IF to_regclass(format('%I.sessions', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.sessions ENABLE ROW LEVEL SECURITY', target_schema);

      EXECUTE format('DROP POLICY IF EXISTS sessions_public_read ON %I.sessions', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS sessions_select_own ON %I.sessions', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS sessions_insert_own ON %I.sessions', target_schema);

      EXECUTE format(
        $sql$
          CREATE POLICY sessions_select_own ON %I.sessions
            FOR SELECT TO authenticated
            USING (
              EXISTS (
                SELECT 1
                FROM %I.profiles owner_profile
                WHERE owner_profile.id = sessions.profile_id
                  AND owner_profile.user_id = auth.uid()
              )
            )
        $sql$,
        target_schema,
        target_schema
      );

      EXECUTE format(
        $sql$
          CREATE POLICY sessions_insert_own ON %I.sessions
            FOR INSERT TO authenticated
            WITH CHECK (
              EXISTS (
                SELECT 1
                FROM %I.profiles owner_profile
                WHERE owner_profile.id = sessions.profile_id
                  AND owner_profile.user_id = auth.uid()
              )
            )
        $sql$,
        target_schema,
        target_schema
      );
    END IF;

    IF to_regclass(format('%I.daily_aggregates', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.daily_aggregates ENABLE ROW LEVEL SECURITY', target_schema);

      EXECUTE format('DROP POLICY IF EXISTS aggregates_public_read ON %I.daily_aggregates', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS daily_aggregates_select_own ON %I.daily_aggregates', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS daily_aggregates_select_own_or_public ON %I.daily_aggregates', target_schema);

      EXECUTE format(
        $sql$
          CREATE POLICY daily_aggregates_select_own_or_public ON %I.daily_aggregates
            FOR SELECT TO anon, authenticated
            USING (
              EXISTS (
                SELECT 1
                FROM %I.profiles owner_profile
                WHERE owner_profile.id = daily_aggregates.profile_id
                  AND (
                    owner_profile.user_id = auth.uid()
                    OR (owner_profile.handle IS NOT NULL AND owner_profile.mode IS NOT NULL)
                  )
              )
            )
        $sql$,
        target_schema,
        target_schema
      );
    END IF;

    IF to_regclass(format('%I.badges', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.badges ENABLE ROW LEVEL SECURITY', target_schema);

      EXECUTE format('DROP POLICY IF EXISTS badges_public_read ON %I.badges', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS badges_select_public ON %I.badges', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS badges_insert_service_role ON %I.badges', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS badges_update_service_role ON %I.badges', target_schema);

      EXECUTE format(
        $sql$
          CREATE POLICY badges_public_read ON %I.badges
            FOR SELECT TO anon, authenticated
            USING (true)
        $sql$,
        target_schema
      );

      EXECUTE format(
        $sql$
          CREATE POLICY badges_insert_service_role ON %I.badges
            FOR INSERT TO service_role
            WITH CHECK (true)
        $sql$,
        target_schema
      );

      EXECUTE format(
        $sql$
          CREATE POLICY badges_update_service_role ON %I.badges
            FOR UPDATE TO service_role
            USING (true)
            WITH CHECK (true)
        $sql$,
        target_schema
      );
    END IF;

    IF to_regclass(format('%I.profile_badges', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.profile_badges ENABLE ROW LEVEL SECURITY', target_schema);

      EXECUTE format('DROP POLICY IF EXISTS profile_badges_public_read ON %I.profile_badges', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS profile_badges_select_public ON %I.profile_badges', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS profile_badges_insert_service_role ON %I.profile_badges', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS profile_badges_update_service_role ON %I.profile_badges', target_schema);

      EXECUTE format(
        $sql$
          CREATE POLICY profile_badges_public_read ON %I.profile_badges
            FOR SELECT TO anon, authenticated
            USING (true)
        $sql$,
        target_schema
      );

      EXECUTE format(
        $sql$
          CREATE POLICY profile_badges_insert_service_role ON %I.profile_badges
            FOR INSERT TO service_role
            WITH CHECK (true)
        $sql$,
        target_schema
      );

      EXECUTE format(
        $sql$
          CREATE POLICY profile_badges_update_service_role ON %I.profile_badges
            FOR UPDATE TO service_role
            USING (true)
            WITH CHECK (true)
        $sql$,
        target_schema
      );
    END IF;

    IF to_regclass(format('%I.ingestion_runs', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.ingestion_runs ENABLE ROW LEVEL SECURITY', target_schema);

      EXECUTE format('DROP POLICY IF EXISTS ingestion_runs_owner_select ON %I.ingestion_runs', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS ingestion_runs_select_own ON %I.ingestion_runs', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS ingestion_runs_select_admin ON %I.ingestion_runs', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS ingestion_runs_insert_service_role ON %I.ingestion_runs', target_schema);

      EXECUTE format(
        $sql$
          CREATE POLICY ingestion_runs_select_own ON %I.ingestion_runs
            FOR SELECT TO authenticated
            USING (
              EXISTS (
                SELECT 1
                FROM %I.profiles owner_profile
                WHERE owner_profile.id = ingestion_runs.profile_id
                  AND owner_profile.user_id = auth.uid()
              )
            )
        $sql$,
        target_schema,
        target_schema
      );

      EXECUTE format(
        $sql$
          CREATE POLICY ingestion_runs_insert_service_role ON %I.ingestion_runs
            FOR INSERT TO service_role
            WITH CHECK (true)
        $sql$,
        target_schema
      );
    END IF;

    IF to_regclass(format('%I.audit_events', target_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.audit_events ENABLE ROW LEVEL SECURITY', target_schema);

      EXECUTE format('DROP POLICY IF EXISTS audit_events_select_admin ON %I.audit_events', target_schema);
      EXECUTE format('DROP POLICY IF EXISTS audit_events_select_service_role ON %I.audit_events', target_schema);

      EXECUTE format(
        $sql$
          CREATE POLICY audit_events_select_service_role ON %I.audit_events
            FOR SELECT
            USING ((auth.jwt() ->> 'role') = 'service_role')
        $sql$,
        target_schema
      );
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role', target_schema);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO anon, authenticated, service_role', target_schema);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO anon, authenticated, service_role', target_schema);
  END LOOP;
END;
$$;

COMMIT;
