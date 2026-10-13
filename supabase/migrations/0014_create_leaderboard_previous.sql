-- TokensRank Task 23.0: archive table for leaderboard rank deltas.
--
-- The leaderboard service reads this snapshot after each materialized-view
-- refresh. Tests seed it directly to verify rank_delta computation.

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

    EXECUTE format(
      $sql$
        CREATE TABLE IF NOT EXISTS %I.leaderboard_previous (
          profile_id uuid PRIMARY KEY REFERENCES %I.profiles(id) ON DELETE CASCADE,
          rank integer NOT NULL CHECK (rank > 0),
          total_tokens bigint NOT NULL DEFAULT 0,
          refreshed_at timestamptz NOT NULL DEFAULT now()
        )
      $sql$,
      target_schema,
      target_schema
    );
  END LOOP;
END;
$$;

COMMIT;
