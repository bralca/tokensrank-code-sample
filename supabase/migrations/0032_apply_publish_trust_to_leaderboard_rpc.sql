-- Apply local-publish verification trust to the legacy token leaderboard RPC.
--
-- This keeps filtered Claude/Codex boards and fallback token rankings aligned
-- with the profile_summary leaderboard: failed publish checks deboost the
-- effective ranking value, and hidden profiles are excluded everywhere.

BEGIN;

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

    IF to_regclass(format('%I.profile_verification_trust', target_schema)) IS NULL THEN
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
          trusted AS (
            SELECT
              totals.profile_id,
              totals.tokens_total,
              CASE
                WHEN trust.leaderboard_hidden_at IS NOT NULL OR trust.rank_eligible IS FALSE THEN NULL
                ELSE totals.tokens_total::numeric
                  * LEAST(1::numeric, GREATEST(0::numeric, COALESCE(trust.deboost_multiplier, 1::numeric)))
              END AS effective_tokens
            FROM totals
            LEFT JOIN profile_verification_trust trust
              ON trust.profile_id = totals.profile_id
          ),
          ranked AS (
            SELECT
              trusted.profile_id,
              trusted.tokens_total,
              ROW_NUMBER() OVER (
                ORDER BY trusted.effective_tokens DESC, trusted.profile_id ASC
              )::integer AS rank
            FROM trusted
            WHERE COALESCE(trusted.effective_tokens, 0) > 0
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

NOTIFY pgrst, 'reload schema';

COMMIT;
