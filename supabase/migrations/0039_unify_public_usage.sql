-- Public rankings are token rankings. Optional GitHub code is not an entry requirement.
-- Prefer the complete aggregate publication over legacy imported sessions per profile.
BEGIN;
CREATE OR REPLACE FUNCTION public.install_public_usage_functions(schema_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $migration$
DECLARE definition text; s text := schema_name;
BEGIN
  IF s <> 'public' AND s !~ '^tokensrank_test_w[0-9]+$' THEN RAISE EXCEPTION 'Invalid application schema'; END IF;
  EXECUTE replace($ddl$
    CREATE TABLE IF NOT EXISTS __SCHEMA__.published_usage_session_counts (
      profile_id uuid NOT NULL REFERENCES __SCHEMA__.profiles(id) ON DELETE CASCADE,
      date date NOT NULL, source text NOT NULL CHECK(source IN ('claude','codex','opencode')),
      total_sessions integer NOT NULL CHECK(total_sessions>=0), PRIMARY KEY(profile_id,date,source)
    );
    ALTER TABLE __SCHEMA__.published_usage_session_counts ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON __SCHEMA__.published_usage_session_counts FROM PUBLIC,anon,authenticated;
    GRANT ALL ON __SCHEMA__.published_usage_session_counts TO service_role;
    CREATE OR REPLACE VIEW __SCHEMA__.public_usage_daily AS
      SELECT profile_id,date,source,model,total_tokens,total_sessions,cost_usd_total
      FROM __SCHEMA__.usage_daily_aggregates
      UNION ALL
      SELECT d.profile_id,d.date,d.source,d.model,d.total_tokens,d.total_sessions,d.derived_cost_usd
      FROM __SCHEMA__.daily_aggregates d
      WHERE NOT EXISTS (SELECT 1 FROM __SCHEMA__.usage_daily_aggregates u WHERE u.profile_id=d.profile_id);
    REVOKE ALL ON __SCHEMA__.public_usage_daily FROM PUBLIC,anon,authenticated;
    GRANT SELECT ON __SCHEMA__.public_usage_daily TO service_role;

    CREATE OR REPLACE VIEW __SCHEMA__.public_usage_sessions_daily AS
      SELECT profile_id,date,source,total_sessions::bigint FROM __SCHEMA__.published_usage_session_counts
      UNION ALL
      SELECT u.profile_id,u.date,u.source,sum(u.total_sessions)::bigint FROM __SCHEMA__.public_usage_daily u
      WHERE NOT EXISTS (SELECT 1 FROM __SCHEMA__.published_usage_session_counts c WHERE c.profile_id=u.profile_id)
      GROUP BY u.profile_id,u.date,u.source;
    REVOKE ALL ON __SCHEMA__.public_usage_sessions_daily FROM PUBLIC,anon,authenticated;
    GRANT SELECT ON __SCHEMA__.public_usage_sessions_daily TO service_role;

    CREATE OR REPLACE FUNCTION __SCHEMA__.query_usage_leaderboard(
      p_start_date date DEFAULT NULL, p_source text DEFAULT NULL,
      p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_profile_id uuid DEFAULT NULL
    ) RETURNS TABLE(profile_id uuid,tokens_total bigint,rank bigint,cost_usd_total numeric,
      sessions_count bigint,top_model text,total_count bigint)
    LANGUAGE sql STABLE SET search_path=__SCHEMA__,public AS $fn$
      WITH filtered AS (
        SELECT u.* FROM public_usage_daily u
        WHERE (p_start_date IS NULL OR u.date>=p_start_date)
          AND u.date<=(now() AT TIME ZONE 'UTC')::date
          AND (p_source IS NULL OR u.source=p_source)
      ), totals AS (
        SELECT f.profile_id,sum(f.total_tokens)::bigint tokens_total,
          sum(f.cost_usd_total) cost_usd_total,sum(f.total_sessions)::bigint sessions_count
        FROM filtered f GROUP BY f.profile_id
      ), eligible AS (
        SELECT t.*,t.tokens_total*least(1,greatest(0,coalesce(v.deboost_multiplier,1))) effective_tokens
        FROM totals t LEFT JOIN profile_verification_trust v ON v.profile_id=t.profile_id
        WHERE v.leaderboard_hidden_at IS NULL AND v.rank_eligible IS DISTINCT FROM FALSE
      ), ranked AS (
        SELECT e.*,row_number() OVER(ORDER BY e.effective_tokens DESC,e.profile_id) rank,
          count(*) OVER() total_count FROM eligible e WHERE e.effective_tokens>0
      )
      SELECT r.profile_id,r.tokens_total,r.rank,r.cost_usd_total,
        coalesce((SELECT sum(c.total_sessions)::bigint FROM public_usage_sessions_daily c
          WHERE c.profile_id=r.profile_id AND (p_start_date IS NULL OR c.date>=p_start_date)
          AND c.date<=(now() AT TIME ZONE 'UTC')::date AND (p_source IS NULL OR c.source=p_source)),0),
        (SELECT f.model FROM filtered f WHERE f.profile_id=r.profile_id
          GROUP BY f.model ORDER BY sum(f.total_tokens) DESC,f.model LIMIT 1),r.total_count
      FROM ranked r WHERE p_profile_id IS NULL OR r.profile_id=p_profile_id
      ORDER BY r.rank LIMIT greatest(0,p_limit) OFFSET greatest(0,p_offset);
    $fn$;
    REVOKE ALL ON FUNCTION __SCHEMA__.query_usage_leaderboard(date,text,integer,integer,uuid) FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION __SCHEMA__.query_usage_leaderboard(date,text,integer,integer,uuid) TO service_role;

    CREATE OR REPLACE FUNCTION __SCHEMA__.count_usage_leaderboard(p_start_date date DEFAULT NULL,p_source text DEFAULT NULL)
      RETURNS bigint LANGUAGE sql STABLE SET search_path=__SCHEMA__,public AS $fn$
      SELECT coalesce((SELECT total_count FROM query_usage_leaderboard(p_start_date,p_source,1,0,NULL)),0);
    $fn$;
    REVOKE ALL ON FUNCTION __SCHEMA__.count_usage_leaderboard(date,text) FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION __SCHEMA__.count_usage_leaderboard(date,text) TO service_role;

    CREATE OR REPLACE FUNCTION __SCHEMA__.public_usage_stats(p_start_date date)
      RETURNS TABLE(connected bigint,tokens bigint,sessions bigint,cost numeric)
      LANGUAGE sql STABLE SET search_path=__SCHEMA__,public AS $fn$
      SELECT count(DISTINCT u.profile_id),coalesce(sum(u.total_tokens),0)::bigint,
        coalesce((SELECT sum(c.total_sessions) FROM public_usage_sessions_daily c
          LEFT JOIN profile_verification_trust v ON v.profile_id=c.profile_id
          WHERE c.date>=p_start_date AND c.date<=(now() AT TIME ZONE 'UTC')::date
            AND v.leaderboard_hidden_at IS NULL AND v.rank_eligible IS DISTINCT FROM FALSE
            AND coalesce(v.deboost_multiplier,1)>0),0)::bigint,coalesce(sum(u.cost_usd_total),0)
      FROM public_usage_daily u LEFT JOIN profile_verification_trust v ON v.profile_id=u.profile_id
      WHERE u.date>=p_start_date AND u.date<=(now() AT TIME ZONE 'UTC')::date
        AND u.total_tokens>0 AND v.leaderboard_hidden_at IS NULL AND v.rank_eligible IS DISTINCT FROM FALSE
        AND coalesce(v.deboost_multiplier,1)>0;
    $fn$;
    REVOKE ALL ON FUNCTION __SCHEMA__.public_usage_stats(date) FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION __SCHEMA__.public_usage_stats(date) TO service_role;
  $ddl$, '__SCHEMA__', quote_ident(s));
  -- Extend the existing lease-checked atomic commit. Counts replace together with
  -- usage; a failed insert rolls back the complete publication, including trust.
  SELECT pg_get_functiondef(to_regprocedure(format('%I.finish_local_publish(uuid,uuid,text,jsonb,jsonb)',s))) INTO definition;
  IF position('published_usage_session_counts' in definition)=0 THEN
    definition := replace(definition, $$IF p_status='passed' THEN$$, $patch$IF p_status='passed' THEN
      DELETE FROM published_usage_session_counts WHERE profile_id=j.profile_id;
      INSERT INTO published_usage_session_counts(profile_id,date,source,total_sessions)
        SELECT j.profile_id,x.date,x.source,x.total_sessions
        FROM jsonb_to_recordset(coalesce(j.payload->'session_counts_daily','[]'::jsonb))
          AS x(date date,source text,total_sessions integer);
    $patch$);
    EXECUTE definition;
  END IF;
END $migration$;
REVOKE ALL ON FUNCTION public.install_public_usage_functions(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.install_public_usage_functions(text) TO service_role;
SELECT public.install_public_usage_functions(COALESCE(NULLIF(current_setting('tokensrank.target_schema',true),''),'public'));
DO $reset$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.reset_test_schema(text)'::regprocedure) INTO definition;
  IF position('install_public_usage_functions' in definition)=0 THEN
    EXECUTE replace(definition,'PERFORM public.install_publish_functions(schema_name);',
      'PERFORM public.install_publish_functions(schema_name); PERFORM public.install_public_usage_functions(schema_name);');
  END IF;
END $reset$;
NOTIFY pgrst,'reload schema';
COMMIT;
