-- A reusable, aggregate-only read model for public directories and rankings.
-- No new raw records are collected. Modern publications replace legacy imports.
BEGIN;
CREATE OR REPLACE FUNCTION public.install_usage_explorer(schema_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $migration$
BEGIN
  IF schema_name <> 'public' AND schema_name !~ '^tokensrank_test_w[0-9]+$' THEN RAISE EXCEPTION 'Invalid application schema'; END IF;
  EXECUTE replace($ddl$
    CREATE OR REPLACE VIEW __SCHEMA__.public_usage_facts AS
      SELECT u.profile_id,u.date,u.source,u.model,coalesce(a.provider,'unknown') provider,
        u.total_tokens,u.cost_usd_total,a.output_tokens,
        least(1,greatest(0,coalesce(t.deboost_multiplier,1))) trust_multiplier
      FROM __SCHEMA__.public_usage_daily u
      JOIN __SCHEMA__.profiles p ON p.id=u.profile_id
      LEFT JOIN __SCHEMA__.usage_daily_aggregates a
        ON a.profile_id=u.profile_id AND a.date=u.date AND a.source=u.source AND a.model=u.model
      LEFT JOIN __SCHEMA__.profile_verification_trust t ON t.profile_id=u.profile_id
      WHERE p.handle IS NOT NULL AND u.total_tokens>0 AND u.date<=(now() AT TIME ZONE 'UTC')::date
        AND t.leaderboard_hidden_at IS NULL AND t.rank_eligible IS DISTINCT FROM FALSE
        AND coalesce(t.deboost_multiplier,1)>0;

    CREATE OR REPLACE VIEW __SCHEMA__.public_usage_dimensions AS
      SELECT DISTINCT d.kind,d.key,
        CASE WHEN d.kind='model' THEN
          coalesce(nullif(trim(both '-' from regexp_replace(lower(d.key),'[^a-z0-9]+','-','g')),''),'model')
            || '-' || substr(md5(d.key),1,8)
          ELSE d.key END slug
      FROM __SCHEMA__.public_usage_facts f
      CROSS JOIN LATERAL (VALUES ('model',f.model),('tool',f.source),('provider',f.provider)) d(kind,key)
      WHERE d.key IS NOT NULL AND d.key<>'';

    CREATE OR REPLACE FUNCTION __SCHEMA__.query_usage_catalog(p_kind text DEFAULT 'model',p_start_date date DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql STABLE SET search_path=__SCHEMA__,public AS $fn$
      WITH grouped AS (
        SELECT d.kind,d.key,d.slug,sum(f.total_tokens)::bigint tokens,
          sum(f.cost_usd_total) api_value,count(DISTINCT f.profile_id) builders,
          CASE WHEN count(f.output_tokens)=count(*) THEN sum(f.output_tokens)::bigint END output_tokens,
          min(f.date) first_date,max(f.date) last_date,
          array_agg(DISTINCT f.source ORDER BY f.source) tools,
          array_agg(DISTINCT f.provider ORDER BY f.provider) providers
        FROM public_usage_dimensions d JOIN public_usage_facts f
          ON d.key=CASE d.kind WHEN 'model' THEN f.model WHEN 'tool' THEN f.source ELSE f.provider END
        WHERE d.kind=p_kind AND (p_start_date IS NULL OR f.date>=p_start_date)
        GROUP BY d.kind,d.key,d.slug
      ) SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.tokens DESC,g.key),'[]'::jsonb) FROM grouped g;
    $fn$;

    CREATE OR REPLACE FUNCTION __SCHEMA__.query_usage_dimension(
      p_kind text,p_slug text,p_start_date date DEFAULT NULL,p_limit integer DEFAULT 50,p_offset integer DEFAULT 0
    ) RETURNS jsonb LANGUAGE sql STABLE SET search_path=__SCHEMA__,public AS $fn$
      WITH dimension AS (
        SELECT * FROM public_usage_dimensions WHERE kind=p_kind AND slug=p_slug
      ), filtered AS (
        SELECT f.* FROM public_usage_facts f JOIN dimension d
          ON d.key=CASE d.kind WHEN 'model' THEN f.model WHEN 'tool' THEN f.source ELSE f.provider END
        WHERE p_start_date IS NULL OR f.date>=p_start_date
      ), builders AS (
        SELECT f.profile_id,sum(f.total_tokens)::bigint tokens,sum(f.cost_usd_total) api_value,
          CASE WHEN count(f.output_tokens)=count(*) THEN sum(f.output_tokens)::bigint END output_tokens,
          sum(f.total_tokens*f.trust_multiplier) effective_tokens,
          count(DISTINCT f.model) models,count(DISTINCT f.source) tools
        FROM filtered f GROUP BY f.profile_id
      ), ranked AS (
        SELECT b.*,row_number() OVER(ORDER BY b.effective_tokens DESC,b.profile_id) rank FROM builders b
      ), page AS (
        SELECT r.rank,p.handle,p.display_name,
          coalesce(p.avatar_url,CASE WHEN g.github_user_id>0 THEN 'https://avatars.githubusercontent.com/u/'||g.github_user_id||'?s=96' END) avatar_url,
          r.tokens,r.api_value,r.output_tokens,r.models,r.tools
        FROM ranked r JOIN profiles p ON p.id=r.profile_id
        LEFT JOIN github_identities g ON g.profile_id=r.profile_id
        ORDER BY r.rank LIMIT least(50,greatest(1,p_limit)) OFFSET greatest(0,p_offset)
      ), breakdown AS (
        SELECT d.kind,d.key,d.slug,sum(f.total_tokens)::bigint tokens,count(DISTINCT f.profile_id) builders
        FROM filtered f JOIN public_usage_dimensions d
          ON d.key=CASE d.kind WHEN 'model' THEN f.model WHEN 'tool' THEN f.source ELSE f.provider END
        WHERE d.kind<>p_kind GROUP BY d.kind,d.key,d.slug
      ) SELECT jsonb_build_object(
        'dimension',(SELECT to_jsonb(d) FROM dimension d),
        'tokens',coalesce((SELECT sum(tokens) FROM builders),0),
        'api_value',coalesce((SELECT sum(api_value) FROM builders),0),
        'output_tokens',(SELECT CASE WHEN count(output_tokens)=count(*) THEN sum(output_tokens) END FROM filtered),
        'builders',(SELECT count(*) FROM builders),
        'community_tokens',coalesce((SELECT sum(total_tokens) FROM public_usage_facts WHERE p_start_date IS NULL OR date>=p_start_date),0),
        'first_date',(SELECT min(date) FROM filtered),'last_date',(SELECT max(date) FROM filtered),
        'rows',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.rank) FROM page p),'[]'::jsonb),
        'breakdown',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.tokens DESC,b.key) FROM breakdown b),'[]'::jsonb)
      );
    $fn$;

    REVOKE ALL ON __SCHEMA__.public_usage_facts,__SCHEMA__.public_usage_dimensions FROM PUBLIC,anon,authenticated;
    GRANT SELECT ON __SCHEMA__.public_usage_facts,__SCHEMA__.public_usage_dimensions TO service_role;
    REVOKE ALL ON FUNCTION __SCHEMA__.query_usage_catalog(text,date),__SCHEMA__.query_usage_dimension(text,text,date,integer,integer) FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION __SCHEMA__.query_usage_catalog(text,date),__SCHEMA__.query_usage_dimension(text,text,date,integer,integer) TO service_role;

    -- Existing GitHub-linked accounts get their public avatar too. Custom photos win.
    UPDATE __SCHEMA__.profiles p SET avatar_url='https://avatars.githubusercontent.com/u/'||g.github_user_id||'?s=192'
      FROM __SCHEMA__.github_identities g WHERE g.profile_id=p.id AND g.github_user_id>0 AND p.avatar_url IS NULL;
  $ddl$, '__SCHEMA__', quote_ident(schema_name));
END $migration$;
REVOKE ALL ON FUNCTION public.install_usage_explorer(text) FROM PUBLIC,anon,authenticated;
DO $$ BEGIN
  PERFORM public.install_usage_explorer(coalesce(nullif(current_setting('tokensrank.target_schema',true),''),'public'));
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
