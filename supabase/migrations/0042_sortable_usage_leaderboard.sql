-- Rank the complete eligible population before pagination. Keep all displayed
-- metrics scoped to the same UTC period and tool, and retain publication trust.
BEGIN;
CREATE OR REPLACE FUNCTION public.install_sortable_usage_leaderboard(schema_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $migration$
DECLARE s text := schema_name; definition text;
BEGIN
  IF s <> 'public' AND s !~ '^tokensrank_test_w[0-9]+$' THEN RAISE EXCEPTION 'Invalid application schema'; END IF;
  EXECUTE replace($ddl$
    CREATE OR REPLACE FUNCTION __SCHEMA__.query_usage_leaderboard_sorted(
      p_start_date date DEFAULT NULL, p_source text DEFAULT NULL,
      p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_profile_id uuid DEFAULT NULL,
      p_sort text DEFAULT 'cost', p_order text DEFAULT 'desc'
    ) RETURNS TABLE(profile_id uuid,tokens_total bigint,rank bigint,cost_usd_total numeric,
      sessions_count bigint,top_model text,total_count bigint,active_days bigint,api_value_partial boolean)
    LANGUAGE sql STABLE SET search_path=__SCHEMA__,public AS $fn$
      WITH filtered AS (
        SELECT f.* FROM public_usage_facts f
        WHERE (p_start_date IS NULL OR f.date>=p_start_date)
          AND (p_source IS NULL OR f.source=p_source)
      ), session_totals AS (
        -- Session counts are published separately so using several models in
        -- one session does not multiply the session count.
        SELECT c.profile_id,sum(c.total_sessions)::bigint sessions_count
        FROM public_usage_sessions_daily c
        WHERE (p_start_date IS NULL OR c.date>=p_start_date)
          AND c.date<=(now() AT TIME ZONE 'UTC')::date
          AND (p_source IS NULL OR c.source=p_source)
        GROUP BY c.profile_id
      ), totals AS (
        SELECT f.profile_id,sum(f.total_tokens)::bigint tokens_total,
          sum(f.cost_usd_total) cost_usd_total,
          coalesce(max(c.sessions_count),0)::bigint sessions_count,
          count(DISTINCT f.date) active_days,bool_or(f.api_value_partial) api_value_partial,
          max(f.trust_multiplier) trust_multiplier
        FROM filtered f LEFT JOIN session_totals c ON c.profile_id=f.profile_id
        GROUP BY f.profile_id
      ), scored AS (
        SELECT t.*,(CASE p_sort WHEN 'tokens' THEN t.tokens_total
          WHEN 'sessions' THEN t.sessions_count WHEN 'active_days' THEN t.active_days
          ELSE t.cost_usd_total END)*t.trust_multiplier effective_value
        FROM totals t
      ), ranked AS (
        SELECT e.*,row_number() OVER(ORDER BY e.effective_value DESC,e.profile_id) rank,
          count(*) OVER() total_count FROM scored e
      )
      SELECT r.profile_id,r.tokens_total,r.rank,r.cost_usd_total,r.sessions_count,
        (SELECT f.model FROM filtered f WHERE f.profile_id=r.profile_id
          GROUP BY f.model ORDER BY sum(f.total_tokens) DESC,f.model LIMIT 1),
        r.total_count,r.active_days,r.api_value_partial
      FROM ranked r WHERE p_profile_id IS NULL OR r.profile_id=p_profile_id
      ORDER BY CASE WHEN p_order='asc' THEN -r.rank ELSE r.rank END
      LIMIT greatest(0,p_limit) OFFSET greatest(0,p_offset);
    $fn$;
    REVOKE ALL ON FUNCTION __SCHEMA__.query_usage_leaderboard_sorted(date,text,integer,integer,uuid,text,text) FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION __SCHEMA__.query_usage_leaderboard_sorted(date,text,integer,integer,uuid,text,text) TO service_role;

    -- Preserve the previous RPC shape for existing consumers, while making
    -- their overall rank agree with the leaderboard's default API-value rank.
    CREATE OR REPLACE FUNCTION __SCHEMA__.query_usage_leaderboard(
      p_start_date date DEFAULT NULL, p_source text DEFAULT NULL,
      p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_profile_id uuid DEFAULT NULL
    ) RETURNS TABLE(profile_id uuid,tokens_total bigint,rank bigint,cost_usd_total numeric,
      sessions_count bigint,top_model text,total_count bigint)
    LANGUAGE sql STABLE SET search_path=__SCHEMA__,public AS $fn$
      SELECT r.profile_id,r.tokens_total,r.rank,r.cost_usd_total,r.sessions_count,r.top_model,r.total_count
      FROM query_usage_leaderboard_sorted(p_start_date,p_source,p_limit,p_offset,p_profile_id,'cost','desc') r;
    $fn$;
  $ddl$,'__SCHEMA__',quote_ident(s));
END $migration$;
REVOKE ALL ON FUNCTION public.install_sortable_usage_leaderboard(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.install_sortable_usage_leaderboard(text) TO service_role;
SELECT public.install_sortable_usage_leaderboard(coalesce(nullif(current_setting('tokensrank.target_schema',true),''),'public'));
DO $reset$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.reset_test_schema(text)'::regprocedure) INTO definition;
  IF position('install_sortable_usage_leaderboard' in definition)=0 THEN
    EXECUTE replace(definition,'PERFORM public.install_profile_evidence(schema_name);',
      'PERFORM public.install_profile_evidence(schema_name); PERFORM public.install_sortable_usage_leaderboard(schema_name);');
  END IF;
END $reset$;
NOTIFY pgrst,'reload schema';
COMMIT;
