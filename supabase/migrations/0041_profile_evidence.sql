-- Keep the receipt's evidence summary together with the successful publication.
BEGIN;
CREATE OR REPLACE FUNCTION public.install_profile_evidence(schema_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $migration$
DECLARE s text:=schema_name; definition text;
BEGIN
  IF s <> 'public' AND s !~ '^tokensrank_test_w[0-9]+$' THEN RAISE EXCEPTION 'Invalid application schema'; END IF;
  EXECUTE replace($ddl$
    CREATE TABLE IF NOT EXISTS __SCHEMA__.published_profile_evidence (
      profile_id uuid PRIMARY KEY REFERENCES __SCHEMA__.profiles(id) ON DELETE CASCADE,
      publish_run_id uuid NOT NULL REFERENCES __SCHEMA__.local_publish_runs(id) ON DELETE CASCADE,
      published_at timestamptz NOT NULL, usage jsonb,
      repositories integer NOT NULL DEFAULT 0,
      commits integer NOT NULL DEFAULT 0, checked_at timestamptz
    );
    ALTER TABLE __SCHEMA__.published_profile_evidence ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON __SCHEMA__.published_profile_evidence FROM PUBLIC,anon,authenticated;
    GRANT ALL ON __SCHEMA__.published_profile_evidence TO service_role;
    CREATE OR REPLACE VIEW __SCHEMA__.public_usage_facts AS
      SELECT u.profile_id,u.date,u.source,u.model,coalesce(a.provider,'unknown') provider,
        u.total_tokens,u.cost_usd_total,a.output_tokens,
        least(1,greatest(0,coalesce(t.deboost_multiplier,1))) trust_multiplier,
        EXISTS(SELECT 1 FROM __SCHEMA__.published_profile_evidence e,
          jsonb_array_elements(coalesce(e.usage->'sources','[]'::jsonb)) source_evidence
          WHERE e.profile_id=u.profile_id AND source_evidence->>'source'=u.source
            AND coalesce(source_evidence->'unpriced_models','[]'::jsonb) ? u.model) AS api_value_partial
      FROM __SCHEMA__.public_usage_daily u JOIN __SCHEMA__.profiles p ON p.id=u.profile_id
      LEFT JOIN __SCHEMA__.usage_daily_aggregates a
        ON a.profile_id=u.profile_id AND a.date=u.date AND a.source=u.source AND a.model=u.model
      LEFT JOIN __SCHEMA__.profile_verification_trust t ON t.profile_id=u.profile_id
      WHERE p.handle IS NOT NULL AND u.total_tokens>0 AND u.date<=(now() AT TIME ZONE 'UTC')::date
        AND t.leaderboard_hidden_at IS NULL AND t.rank_eligible IS DISTINCT FROM FALSE
        AND coalesce(t.deboost_multiplier,1)>0;
    CREATE OR REPLACE FUNCTION __SCHEMA__.query_profile_evidence(p_profile_id uuid,p_start_date date DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql STABLE SET search_path=__SCHEMA__,public AS $fn$
      WITH category_totals AS (
        SELECT f.profile_id,d.kind,d.key,d.slug,sum(f.total_tokens) tokens,
          sum(f.total_tokens)*max(f.trust_multiplier) effective_tokens
        FROM public_usage_facts f JOIN public_usage_dimensions d ON
          (d.kind='model' AND d.key=f.model) OR (d.kind='tool' AND d.key=f.source)
        WHERE p_start_date IS NULL OR f.date>=p_start_date
        GROUP BY f.profile_id,d.kind,d.key,d.slug
      ), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY kind,key ORDER BY effective_tokens DESC,profile_id) rank,
          count(*) OVER(PARTITION BY kind,key) builders
        FROM category_totals WHERE effective_tokens>0
      ), own_categories AS (
        SELECT * FROM ranked WHERE profile_id=p_profile_id ORDER BY tokens DESC,kind,key LIMIT 6
      ), publication AS (
        SELECT * FROM published_profile_evidence WHERE profile_id=p_profile_id
      )
      SELECT jsonb_build_object(
        'github_login',(SELECT login FROM github_identities WHERE profile_id=p_profile_id),
        'published_at',coalesce((SELECT published_at FROM publication),
          (SELECT max(completed_at) FROM local_publish_runs WHERE profile_id=p_profile_id AND verification_status='passed')),
        'usage',(SELECT usage FROM publication),
        'output_tokens',(SELECT sum(output_tokens) FROM usage_daily_aggregates
          WHERE profile_id=p_profile_id AND (p_start_date IS NULL OR date>=p_start_date)
            AND date<=(now() AT TIME ZONE 'UTC')::date),
        'contribution',(SELECT CASE WHEN repositories>0 THEN jsonb_build_object(
          'repositories',repositories,'commits',commits,'checked_at',checked_at) ELSE NULL END FROM publication),
        'standings',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',kind,'key',key,'slug',slug,'rank',rank,'builders',builders)
          ORDER BY tokens DESC,kind,key) FROM own_categories),'[]'::jsonb)
      );
    $fn$;
    REVOKE ALL ON FUNCTION __SCHEMA__.query_profile_evidence(uuid,date) FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION __SCHEMA__.query_profile_evidence(uuid,date) TO service_role;
  $ddl$,'__SCHEMA__',quote_ident(s));
  SELECT pg_get_functiondef(to_regprocedure(format('%I.query_usage_catalog(text,date)',s))) INTO definition;
  IF position('api_value_partial' in definition)=0 THEN
    EXECUTE replace(definition,'sum(f.cost_usd_total) api_value,','sum(f.cost_usd_total) api_value,bool_or(f.api_value_partial) api_value_partial,');
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(format('%I.query_usage_dimension(text,text,date,integer,integer)',s))) INTO definition;
  IF position('api_value_partial' in definition)=0 THEN
    definition:=replace(definition,'sum(f.cost_usd_total) api_value,','sum(f.cost_usd_total) api_value,bool_or(f.api_value_partial) api_value_partial,');
    definition:=replace(definition,'r.tokens,r.api_value,r.output_tokens','r.tokens,r.api_value,r.api_value_partial,r.output_tokens');
    EXECUTE definition;
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(format('%I.finish_local_publish(uuid,uuid,text,jsonb,jsonb)',s))) INTO definition;
  IF position('published_profile_evidence' in definition)=0 THEN
    definition:=replace(definition,$$IF p_status='passed' THEN$$,$patch$IF p_status='passed' THEN
      INSERT INTO published_profile_evidence(profile_id,publish_run_id,published_at,usage,repositories,commits,checked_at)
      VALUES(j.profile_id,p_run_id,now(),nullif(j.payload->'usage_evidence','null'::jsonb),
        jsonb_array_length(coalesce(j.payload->'selected_repos','[]'::jsonb)),
        coalesce((p_result->>'remote_github_commit_total')::integer,0),
        (p_result->>'remote_github_verified_at')::timestamptz)
      ON CONFLICT(profile_id) DO UPDATE SET publish_run_id=excluded.publish_run_id,published_at=excluded.published_at,
        usage=excluded.usage,repositories=excluded.repositories,commits=excluded.commits,checked_at=excluded.checked_at;
    $patch$);
    EXECUTE definition;
  END IF;
END $migration$;
REVOKE ALL ON FUNCTION public.install_profile_evidence(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.install_profile_evidence(text) TO service_role;
SELECT public.install_profile_evidence(coalesce(nullif(current_setting('tokensrank.target_schema',true),''),'public'));
DO $reset$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.reset_test_schema(text)'::regprocedure) INTO definition;
  IF position('install_profile_evidence' in definition)=0 THEN
    EXECUTE replace(definition,'PERFORM public.install_public_usage_functions(schema_name);',
      'PERFORM public.install_public_usage_functions(schema_name); PERFORM public.install_usage_explorer(schema_name); PERFORM public.install_profile_evidence(schema_name);');
  END IF;
END $reset$;
NOTIFY pgrst,'reload schema';
COMMIT;
