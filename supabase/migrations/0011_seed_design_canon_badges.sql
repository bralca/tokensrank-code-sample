-- TokensRank Task 5.0: keep the design-canon badge catalog canonical.
--
-- This migration is intentionally idempotent. It removes legacy badge
-- definitions, preserves awards for canonical badge slugs, and upserts the
-- 16 design-canon badge definitions required by the product contract.

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
    IF to_regclass(format('%I.badges', target_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        WITH canonical (
          slug,
          name,
          description,
          icon_slug,
          criteria_json,
          requires_verification,
          tier
        ) AS (
          VALUES
            (
              'tier',
              'Tier',
              'Top one percent token usage threshold: 25M lifetime tokens.',
              '◇',
              '{"threshold_tokens":25000000}'::jsonb,
              true,
              'legendary'
            ),
            (
              'iron_streak',
              'Iron Streak',
              '30+ consecutive days with recorded coding sessions.',
              '▮',
              '{"min_consecutive_days":30}'::jsonb,
              true,
              'rare'
            ),
            (
              'operator',
              'Operator',
              'Power-user cadence: 10 or more sessions per day on average.',
              '⌬',
              '{"min_sessions_per_day_avg":10}'::jsonb,
              true,
              'rare'
            ),
            (
              'cache_whisperer',
              'Cache Whisperer',
              'Cache-read tokens are more than 30 percent of total usage.',
              '◈',
              '{"min_cache_read_ratio":0.3}'::jsonb,
              true,
              'rare'
            ),
            (
              'night_owl',
              'Night Owl',
              'At least half of sessions land between 22:00 and 06:00.',
              '☾',
              '{"min_night_sessions_pct":0.5,"night_start_hour":22,"night_end_hour":6}'::jsonb,
              false,
              'standard'
            ),
            (
              'multi_provider',
              'Multi-Provider',
              'Uses both Claude and Codex.',
              '◫',
              '{"requires_claude":true,"requires_codex":true}'::jsonb,
              false,
              'standard'
            ),
            (
              'conductor',
              'Conductor',
              'Uses five or more distinct models.',
              '⬢',
              '{"min_models_used":5}'::jsonb,
              false,
              'rare'
            ),
            (
              'outage_witness',
              'Outage Witness',
              'Has a session tagged with a provider or API error.',
              '✦',
              '{"requires_error_tag":true}'::jsonb,
              false,
              'legendary'
            ),
            (
              'reasoning_junkie',
              'Reasoning Junkie',
              'Reasoning tokens are present and exceed 10 percent of total output.',
              '◯',
              '{"min_reasoning_tokens":1,"min_reasoning_ratio":0.1}'::jsonb,
              true,
              'rare'
            ),
            (
              'marathoner',
              'Marathoner',
              'Logged a single session longer than six hours.',
              '◢',
              '{"min_session_hours":6}'::jsonb,
              false,
              'standard'
            ),
            (
              'detonation',
              'Detonation',
              'Exceeded 10M total tokens in one UTC day.',
              '▲',
              '{"min_daily_tokens":10000000}'::jsonb,
              false,
              'rare'
            ),
            (
              'long_context',
              'Long-Context',
              'Worked with more than 100k context tokens.',
              '❒',
              '{"min_context_tokens":100000}'::jsonb,
              false,
              'standard'
            ),
            (
              'defection_arc',
              'Defection Arc',
              'Had a Claude phase and later switched to Codex.',
              '◐',
              '{"from_model":"claude","to_model":"codex"}'::jsonb,
              false,
              'standard'
            ),
            (
              'two_tool',
              'Two-Tool',
              'Uses both Claude and Codex in a balanced workflow.',
              '☰',
              '{"requires_both_models":true}'::jsonb,
              false,
              'standard'
            ),
            (
              'drifter',
              'Drifter',
              'Uses eight or more distinct models.',
              '◌',
              '{"min_models_used":8}'::jsonb,
              false,
              'standard'
            ),
            (
              'sniper',
              'Sniper',
              'At least 90 percent of usage is concentrated in one model.',
              '❖',
              '{"require_singular_focus":true,"focus_ratio_threshold":0.9}'::jsonb,
              false,
              'standard'
            )
        ),
        delete_legacy AS (
          DELETE FROM %I.badges badge
          WHERE NOT EXISTS (
            SELECT 1
            FROM canonical
            WHERE canonical.slug = badge.slug
          )
          RETURNING slug
        )
        INSERT INTO %I.badges (
          slug,
          name,
          description,
          icon_slug,
          criteria_json,
          requires_verification,
          tier
        )
        SELECT
          slug,
          name,
          description,
          icon_slug,
          criteria_json,
          requires_verification,
          tier
        FROM canonical
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          icon_slug = EXCLUDED.icon_slug,
          criteria_json = EXCLUDED.criteria_json,
          requires_verification = EXCLUDED.requires_verification,
          tier = EXCLUDED.tier,
          updated_at = now()
      $sql$,
      target_schema,
      target_schema
    );
  END LOOP;
END;
$$;

COMMIT;
