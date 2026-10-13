-- The old verifier compared raw LOC to capped scores and could use incomplete
-- file pages. Those failures are not reliable evidence of inflated claims.
-- Retain their violations for audit, require a new review, and remove only
-- penalties arising from that known, versioned calculation error.
BEGIN;
DO $migration$
DECLARE s text;
BEGIN
  FOR s IN SELECT table_schema FROM information_schema.tables WHERE table_name='local_publish_runs'
    AND table_schema NOT IN ('pg_catalog','information_schema')
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=s AND table_name='local_publish_runs' AND column_name='verification_status') THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %I.local_publish_runs ADD COLUMN IF NOT EXISTS verification_metrics_version integer NOT NULL DEFAULT 1', s);
    EXECUTE format($repair$
      WITH corrected AS (
        UPDATE %1$I.local_publish_runs SET verification_status='unavailable',
          error='The earlier code check used incompatible counting rules. Its penalty was removed. Refresh local code data and review a new receipt.'
        WHERE verification_metrics_version=1 AND verification_status='failed'
          AND error='Published code exceeds hosted GitHub verification totals.'
          AND COALESCE(local_invariant_violations,'[]'::jsonb)='[]'::jsonb
        RETURNING profile_id
      )
      UPDATE %1$I.profile_verification_trust t SET failure_reasons='[]'::jsonb
        WHERE t.profile_id IN (SELECT profile_id FROM corrected);
      WITH counts AS (
        SELECT profile_id,count(*) FILTER (WHERE verification_status='failed')::integer AS failures,
          max(verification_completed_at) FILTER (WHERE verification_status='passed') AS last_pass,
          max(verification_completed_at) FILTER (WHERE verification_status='failed') AS last_fail
        FROM %1$I.local_publish_runs GROUP BY profile_id
      )
      UPDATE %1$I.profile_verification_trust t SET
        failed_publish_count=c.failures,
        consecutive_failed_publish_count=(SELECT count(*) FROM %1$I.local_publish_runs r WHERE r.profile_id=t.profile_id AND r.verification_status='failed' AND (c.last_pass IS NULL OR r.verification_completed_at>c.last_pass)),
        deboost_multiplier=CASE WHEN c.failures=0 THEN 1 WHEN c.failures=1 THEN 0.5 WHEN c.failures=2 THEN 0.25 ELSE 0 END,
        leaderboard_hidden_at=CASE WHEN c.failures<3 THEN NULL ELSE t.leaderboard_hidden_at END,
        latest_verification_status=r.verification_status,
        rank_eligible=(r.verification_status='passed' AND c.failures<3),
        last_failed_at=c.last_fail,updated_at=now()
      FROM counts c,%1$I.local_publish_runs r
      WHERE c.profile_id=t.profile_id AND r.id=t.latest_publish_run_id
        AND EXISTS (SELECT 1 FROM %1$I.local_publish_runs old WHERE old.profile_id=t.profile_id
          AND old.verification_metrics_version=1 AND old.verification_status='unavailable'
          AND old.error LIKE 'The earlier code check used incompatible counting rules.%%');
    $repair$,s);
  END LOOP;
END $migration$;
COMMIT;
