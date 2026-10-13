-- Durable publication, atomic replacement, and source compatibility.
BEGIN;

DO $migration$
DECLARE s text; t text; c record; definition text;
BEGIN
  FOR s IN SELECT table_schema FROM information_schema.tables WHERE table_name = 'local_publish_runs'
    AND table_schema NOT IN ('pg_catalog','information_schema')
  LOOP
    -- Historical test schemas may predate the verification/model migrations.
    -- The active schemas must have migrations 0030-0035 before this upgrade.
    IF to_regclass(format('%I.local_published_model_code_daily',s)) IS NULL
      OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=s AND table_name='local_publish_runs' AND column_name='verification_status')
    THEN CONTINUE; END IF;
    FOREACH t IN ARRAY ARRAY['usage_events','usage_source_files','usage_daily_aggregates','usage_session_rollups'] LOOP
      IF to_regclass(format('%I.%I', s, t)) IS NULL THEN CONTINUE; END IF;
      FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = to_regclass(format('%I.%I',s,t))
        AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%source%' AND pg_get_constraintdef(oid) LIKE '%claude%'
      LOOP EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I',s,t,c.conname); END LOOP;
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (source IN (''claude'',''codex'',''opencode''))',s,t,t||'_source_check');
    END LOOP;

    EXECUTE format('ALTER TABLE %I.local_publish_links ADD COLUMN IF NOT EXISTS revoked_at timestamptz',s);
    EXECUTE format('ALTER TABLE %I.local_published_ai_linked_code_daily ADD COLUMN IF NOT EXISTS linked_cost_usd numeric NOT NULL DEFAULT 0 CHECK (linked_cost_usd >= 0)',s);
    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %1$I.local_publish_jobs (
        run_id uuid PRIMARY KEY REFERENCES %1$I.local_publish_runs(id) ON DELETE CASCADE,
        profile_id uuid NOT NULL REFERENCES %1$I.profiles(id) ON DELETE CASCADE,
        payload jsonb NOT NULL,
        phase text NOT NULL DEFAULT 'verify' CHECK (phase IN ('verify','summary')),
        attempts integer NOT NULL DEFAULT 0,
        available_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        lease_token uuid,
        lease_until timestamptz
      );
      CREATE INDEX IF NOT EXISTS local_publish_jobs_ready ON %1$I.local_publish_jobs(available_at,created_at);
      ALTER TABLE %1$I.local_publish_jobs ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON %1$I.local_publish_jobs FROM anon, authenticated;
      GRANT ALL ON %1$I.local_publish_jobs TO service_role;
    $ddl$,s);
    -- Old in-process jobs have no recoverable payload. Give them a terminal,
    -- non-penalizing state so clients can submit a new publish.
    EXECUTE format($orphan$
      UPDATE %1$I.local_publish_runs r SET status='completed',verification_status='unavailable',
        completed_at=now(),verification_completed_at=now(),error='This interrupted publication could not be recovered. Please post again.'
      WHERE verification_status IN ('pending','processing')
        AND NOT EXISTS (SELECT 1 FROM %1$I.local_publish_jobs j WHERE j.run_id=r.id)
    $orphan$,s);

    -- Functions run within their own schema. Only the server role can invoke them.
    definition := $functions$
      CREATE OR REPLACE FUNCTION __SCHEMA__.insert_publish_rows(p_table text, p_rows jsonb)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = __SCHEMA__, pg_temp AS $body$
      DECLARE cols text;
      BEGIN
        IF p_table NOT IN ('local_publish_runs','connected_repos','usage_daily_aggregates','usage_session_rollups',
          'published_code_daily','local_published_github_code_daily','local_published_ai_linked_code_daily',
          'local_published_model_code_daily','contrib_daily') THEN RAISE EXCEPTION 'Unsupported publish table'; END IF;
        IF jsonb_array_length(p_rows) = 0 THEN RETURN; END IF;
        SELECT string_agg(quote_ident(key),',') INTO cols FROM jsonb_object_keys(p_rows->0) key;
        EXECUTE format('INSERT INTO %I.%I (%s) SELECT %s FROM jsonb_populate_recordset(NULL::%I.%I,$1)',
          current_schema(),p_table,cols,cols,current_schema(),p_table) USING p_rows;
      END $body$;

      CREATE OR REPLACE FUNCTION __SCHEMA__.enqueue_local_publish(p_run jsonb, p_payload jsonb)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = __SCHEMA__, pg_temp AS $body$
      BEGIN
        PERFORM insert_publish_rows('local_publish_runs',jsonb_build_array(p_run));
        INSERT INTO local_publish_jobs(run_id,profile_id,payload)
          VALUES ((p_run->>'id')::uuid,(p_run->>'profile_id')::uuid,p_payload);
      END $body$;

      CREATE OR REPLACE FUNCTION __SCHEMA__.claim_local_publish()
      RETURNS SETOF __SCHEMA__.local_publish_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = __SCHEMA__, pg_temp AS $body$
      DECLARE j local_publish_jobs%ROWTYPE;
      BEGIN
        -- Serialize only the short claim transaction, not network verification.
        PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||':publish-claim',0));
        SELECT * INTO j FROM local_publish_jobs q WHERE q.available_at <= now()
          AND (q.lease_until IS NULL OR q.lease_until < now())
          -- Summary ranking spans every profile, so only one publication may
          -- verify/rebuild at a time across API processes.
          AND NOT EXISTS (SELECT 1 FROM local_publish_jobs other WHERE other.run_id<>q.run_id AND other.lease_until > now())
          AND NOT EXISTS (SELECT 1 FROM local_publish_jobs older WHERE older.profile_id=q.profile_id
            AND (older.created_at,older.run_id)<(q.created_at,q.run_id))
          ORDER BY q.created_at,q.run_id LIMIT 1 FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN RETURN; END IF;
        UPDATE local_publish_jobs SET lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1
          WHERE run_id=j.run_id RETURNING * INTO j;
        IF j.phase='verify' THEN
          UPDATE local_publish_runs SET verification_status='processing',verification_started_at=now(),
            verification_attempt_count=j.attempts WHERE id=j.run_id;
        END IF;
        RETURN NEXT j;
      END $body$;

      CREATE OR REPLACE FUNCTION __SCHEMA__.finish_local_publish(p_run_id uuid,p_lease_token uuid,p_status text,p_tables jsonb,p_result jsonb)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = __SCHEMA__, pg_temp AS $body$
      DECLARE j local_publish_jobs%ROWTYPE; t text; rows jsonb; old profile_verification_trust%ROWTYPE; failures integer; hidden timestamptz;
      BEGIN
        SELECT * INTO j FROM local_publish_jobs WHERE run_id=p_run_id FOR UPDATE;
        IF NOT FOUND OR j.lease_token IS DISTINCT FROM p_lease_token OR j.lease_until < clock_timestamp() OR j.phase<>'verify'
          THEN RAISE EXCEPTION 'Publish lease lost'; END IF;
        IF p_status NOT IN ('passed','failed','unavailable') THEN RAISE EXCEPTION 'Invalid publish outcome'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(j.profile_id::text,0));
        IF p_status='passed' THEN
          FOREACH t IN ARRAY ARRAY['connected_repos','usage_daily_aggregates','usage_session_rollups','published_code_daily',
            'local_published_github_code_daily','local_published_ai_linked_code_daily','local_published_model_code_daily','contrib_daily'] LOOP
            rows := p_tables->t;
            IF rows IS NULL OR jsonb_typeof(rows)<>'array' THEN RAISE EXCEPTION 'Missing table %',t; END IF;
            IF EXISTS (SELECT 1 FROM jsonb_array_elements(rows) r WHERE (r->>'profile_id')::uuid IS DISTINCT FROM j.profile_id)
              THEN RAISE EXCEPTION 'Publish profile mismatch'; END IF;
            EXECUTE format('DELETE FROM %I.%I WHERE profile_id=$1',current_schema(),t) USING j.profile_id;
            PERFORM insert_publish_rows(t,rows);
          END LOOP;
          UPDATE profiles SET mode='script_verified',verified=true,updated_at=now()
            WHERE id=j.profile_id AND (
              jsonb_array_length(COALESCE(j.payload->'usage_daily','[]'))>0
              OR jsonb_array_length(COALESCE(j.payload->'model_daily','[]'))>0
              OR jsonb_array_length(COALESCE(j.payload->'github_code_daily','[]'))>0
            );
        END IF;
        SELECT * INTO old FROM profile_verification_trust WHERE profile_id=j.profile_id FOR UPDATE;
        failures := COALESCE(old.failed_publish_count,0) + CASE WHEN p_status='failed' THEN 1 ELSE 0 END;
        hidden := COALESCE(old.leaderboard_hidden_at,CASE WHEN failures>=3 THEN now() END);
        INSERT INTO profile_verification_trust(profile_id,latest_publish_run_id,latest_verification_status,failed_publish_count,
          consecutive_failed_publish_count,deboost_multiplier,rank_eligible,leaderboard_hidden_at,last_verified_at,last_failed_at,failure_reasons,updated_at)
        VALUES(j.profile_id,p_run_id,p_status,failures,
          CASE WHEN p_status='passed' THEN 0 ELSE COALESCE(old.consecutive_failed_publish_count,0)+CASE WHEN p_status='failed' THEN 1 ELSE 0 END END,
          CASE WHEN failures=0 THEN 1 WHEN failures=1 THEN 0.5 WHEN failures=2 THEN 0.25 ELSE 0 END,
          hidden IS NULL AND (p_status='passed' OR old.last_verified_at IS NOT NULL),hidden,
          CASE WHEN p_status='passed' THEN now() ELSE old.last_verified_at END,
          CASE WHEN p_status='failed' THEN now() ELSE old.last_failed_at END,COALESCE(p_result->'verification_violations','[]'),now())
        ON CONFLICT(profile_id) DO UPDATE SET latest_publish_run_id=excluded.latest_publish_run_id,latest_verification_status=excluded.latest_verification_status,
          failed_publish_count=excluded.failed_publish_count,consecutive_failed_publish_count=excluded.consecutive_failed_publish_count,
          deboost_multiplier=excluded.deboost_multiplier,rank_eligible=excluded.rank_eligible,leaderboard_hidden_at=excluded.leaderboard_hidden_at,
          last_verified_at=excluded.last_verified_at,last_failed_at=excluded.last_failed_at,failure_reasons=excluded.failure_reasons,updated_at=now();
        UPDATE local_publish_runs SET status='completed',verification_status=p_status,completed_at=now(),verification_completed_at=now(),
          remote_github_shipped_loc_total=COALESCE((p_result->>'remote_github_shipped_loc_total')::bigint,0),
          remote_github_commit_total=COALESCE((p_result->>'remote_github_commit_total')::integer,0),
          remote_github_day_count=COALESCE((p_result->>'remote_github_day_count')::integer,0),
          remote_github_verified_at=(p_result->>'remote_github_verified_at')::timestamptz,
          verification_violations=COALESCE(p_result->'verification_violations','[]'),error=p_result->>'error'
          WHERE id=p_run_id;
        IF p_status='passed' THEN
          -- Keep a durable summary job until public display has been rebuilt.
          UPDATE local_publish_jobs SET phase='summary',payload='{}',attempts=0 WHERE run_id=p_run_id;
        ELSE DELETE FROM local_publish_jobs WHERE run_id=p_run_id;
        END IF;
      END $body$;
    $functions$;
    EXECUTE replace(definition,'__SCHEMA__',quote_ident(s));
    EXECUTE format('REVOKE ALL ON FUNCTION %I.insert_publish_rows(text,jsonb), %I.enqueue_local_publish(jsonb,jsonb), %I.claim_local_publish(), %I.finish_local_publish(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated',s,s,s,s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.insert_publish_rows(text,jsonb), %I.enqueue_local_publish(jsonb,jsonb), %I.claim_local_publish(), %I.finish_local_publish(uuid,uuid,text,jsonb,jsonb) TO service_role',s,s,s,s);
  END LOOP;

  -- Reuse the same function definitions when the existing test-schema reset
  -- clones the current public tables. No test reset runs during migration.
  EXECUTE format($installer$
    CREATE OR REPLACE FUNCTION public.install_publish_functions(schema_name text)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $installbody$
    BEGIN
      IF schema_name !~ '^tokensrank_test_w[0-9]+$' THEN RAISE EXCEPTION 'Invalid test schema'; END IF;
      EXECUTE replace(%L,'__SCHEMA__',quote_ident(schema_name));
      EXECUTE format('REVOKE ALL ON FUNCTION %%I.insert_publish_rows(text,jsonb), %%I.enqueue_local_publish(jsonb,jsonb), %%I.claim_local_publish(), %%I.finish_local_publish(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated',schema_name,schema_name,schema_name,schema_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %%I.insert_publish_rows(text,jsonb), %%I.enqueue_local_publish(jsonb,jsonb), %%I.claim_local_publish(), %%I.finish_local_publish(uuid,uuid,text,jsonb,jsonb) TO service_role',schema_name,schema_name,schema_name,schema_name);
    END $installbody$;
  $installer$,definition);
  REVOKE ALL ON FUNCTION public.install_publish_functions(text) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.install_publish_functions(text) TO service_role;
END $migration$;

DO $reset$
BEGIN
  IF to_regprocedure('public.reset_test_schema_before_publish_jobs(text)') IS NULL THEN
    ALTER FUNCTION public.reset_test_schema(text) RENAME TO reset_test_schema_before_publish_jobs;
  END IF;
END $reset$;
CREATE OR REPLACE FUNCTION public.reset_test_schema(schema_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $resetbody$
BEGIN
  IF schema_name !~ '^tokensrank_test_w[0-9]+$' THEN RAISE EXCEPTION 'Invalid test schema'; END IF;
  PERFORM public.reset_test_schema_before_publish_jobs(schema_name);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.local_published_model_code_daily (LIKE public.local_published_model_code_daily INCLUDING ALL)',schema_name);
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.local_publish_jobs (LIKE public.local_publish_jobs INCLUDING ALL)',schema_name);
  EXECUTE format('TRUNCATE %I.local_published_model_code_daily,%I.local_publish_jobs',schema_name,schema_name);
  EXECUTE format('ALTER TABLE %I.local_published_model_code_daily ENABLE ROW LEVEL SECURITY',schema_name);
  EXECUTE format('DROP POLICY IF EXISTS model_code_public_read ON %I.local_published_model_code_daily',schema_name);
  EXECUTE format('CREATE POLICY model_code_public_read ON %I.local_published_model_code_daily FOR SELECT TO anon,authenticated USING (true)',schema_name);
  EXECUTE format('GRANT SELECT ON %I.local_published_model_code_daily TO anon,authenticated',schema_name);
  EXECUTE format('GRANT ALL ON %I.local_published_model_code_daily,%I.local_publish_jobs TO service_role',schema_name,schema_name);
  EXECUTE format('ALTER TABLE %I.local_publish_jobs ENABLE ROW LEVEL SECURITY',schema_name);
  EXECUTE format('REVOKE ALL ON %I.local_publish_jobs FROM anon,authenticated',schema_name);
  PERFORM public.install_publish_functions(schema_name);
  PERFORM pg_notify('pgrst','reload schema');
END $resetbody$;
REVOKE ALL ON FUNCTION public.reset_test_schema(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reset_test_schema(text) TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
