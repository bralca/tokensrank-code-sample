-- TokensRank Task 23.0: schema-scoped leaderboard ranking RPC.
--
-- PostgREST aggregate selects are disabled in the hosted API configuration,
-- so the service calls this SQL function to keep aggregation, ROW_NUMBER()
-- ranking, filtering, and pagination inside Postgres.

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
    IF to_regclass(format('%I.daily_aggregates', target_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        CREATE OR REPLACE FUNCTION %I.query_leaderboard_ranked(
          p_start_date date DEFAULT NULL,
          p_source text DEFAULT NULL,
          p_limit integer DEFAULT 50,
          p_offset integer DEFAULT 0
        )
        RETURNS TABLE (
          profile_id uuid,
          tokens_total bigint,
          rank integer
        )
        LANGUAGE sql
        STABLE
        SET search_path = %I, public
        AS $fn$
          WITH totals AS (
            SELECT
              daily_aggregates.profile_id,
              COALESCE(SUM(daily_aggregates.total_tokens), 0)::bigint AS tokens_total
            FROM daily_aggregates
            WHERE
              (p_start_date IS NULL OR daily_aggregates.date >= p_start_date)
              AND (p_source IS NULL OR daily_aggregates.source = p_source)
            GROUP BY daily_aggregates.profile_id
            HAVING COALESCE(SUM(daily_aggregates.total_tokens), 0) > 0
          ),
          ranked AS (
            SELECT
              totals.profile_id,
              totals.tokens_total,
              ROW_NUMBER() OVER (
                ORDER BY totals.tokens_total DESC, totals.profile_id ASC
              )::integer AS rank
            FROM totals
          )
          SELECT
            ranked.profile_id,
            ranked.tokens_total,
            ranked.rank
          FROM ranked
          ORDER BY ranked.rank ASC
          LIMIT GREATEST(p_limit, 0)
          OFFSET GREATEST(p_offset, 0)
        $fn$
      $sql$,
      target_schema,
      target_schema
    );
  END LOOP;
END;
$$;

COMMIT;
