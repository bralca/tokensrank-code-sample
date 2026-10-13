import { describe, expect, it, vi } from 'vitest';

async function loadHelpers() {
  vi.resetModules();
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_ANON_KEY', 'test-anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  vi.stubEnv('SUPABASE_SCHEMA', 'tokensrank_test_w0');

  return await import('./local-publish');
}

describe('local publish verification trust', () => {
  it('rejects model-level code rows that exceed aggregate produced-code rows', async () => {
    const { payloadInvariantViolations } = await loadHelpers();
    const violations = payloadInvariantViolations({
      schema_version: 1,
      client_version: 'test',
      generated_at: '2026-06-04T12:00:00.000Z',
      github_user_id: 123,
      selected_repos: [],
      usage_daily: [],
      model_daily: [],
      usage_session_rollups: [],
      produced_code_daily: [{
        date: '2026-06-04',
        produced_loc: 10,
        produced_loc_score: 10,
        shipped_loc: 4,
        shipped_loc_score: 4,
        ai_linked_commit_count: 1,
        high_confidence_commit_count: 1,
        median_link_confidence: 0.9,
      }],
      github_code_daily: [],
      ai_linked_code_daily: [],
      model_code_daily: [{
        date: '2026-06-04',
        source: 'opencode',
        provider: 'unknown',
        model: 'deepseek-chat-v3',
        produced_loc: 11,
        produced_loc_score: 11,
        shipped_loc: 5,
        shipped_loc_score: 5,
        linked_commit_count: 1,
        linked_tokens: 100,
        linked_cost_usd: 1,
      }],
      pricing_snapshot: [],
      summary: {
        total_tokens: 0,
        total_cost_usd: 0,
        sessions_count: 0,
        produced_loc_total: 10,
        produced_loc_score_total: 10,
        github_shipped_loc_total: 0,
        github_shipped_loc_score_total: 0,
        ai_linked_shipped_loc_total: 0,
        ai_linked_shipped_loc_score_total: 0,
      },
      privacy_report: {
        prompts_sent: 0,
        raw_commands_sent: 0,
        file_contents_sent: 0,
        absolute_paths_sent: 0,
        raw_transcripts_sent: 0,
      },
    });

    expect(violations).toEqual([
      '2026-06-04: model produced LOC exceeds aggregate produced LOC',
      '2026-06-04: model shipped LOC exceeds aggregate shipped LOC',
    ]);
  });

  it('accumulates failed publish checks into deboost and permanent hide state', async () => {
    const { buildProfileVerificationTrustUpdate } = await loadHelpers();
    const now = '2026-06-04T12:00:00.000Z';

    const firstFailure = buildProfileVerificationTrustUpdate({
      profileId: 'profile-1',
      runId: 'run-1',
      status: 'failed',
      existing: null,
      now,
      failureReasons: ['local GitHub claim exceeded hosted verification'],
    });

    expect(firstFailure).toMatchObject({
      failed_publish_count: 1,
      consecutive_failed_publish_count: 1,
      deboost_multiplier: 0.5,
      rank_eligible: false,
      leaderboard_hidden_at: null,
      failure_reasons: ['local GitHub claim exceeded hosted verification'],
    });

    const passAfterFailure = buildProfileVerificationTrustUpdate({
      profileId: 'profile-1',
      runId: 'run-2',
      status: 'passed',
      existing: {
        failed_publish_count: firstFailure.failed_publish_count,
        consecutive_failed_publish_count: firstFailure.consecutive_failed_publish_count,
        leaderboard_hidden_at: firstFailure.leaderboard_hidden_at,
        last_verified_at: null,
        last_failed_at: firstFailure.updated_at,
      },
      now: '2026-06-04T13:00:00.000Z',
    });

    expect(passAfterFailure).toMatchObject({
      failed_publish_count: 1,
      consecutive_failed_publish_count: 0,
      deboost_multiplier: 0.5,
      rank_eligible: true,
      leaderboard_hidden_at: null,
      last_verified_at: '2026-06-04T13:00:00.000Z',
      last_failed_at: firstFailure.updated_at,
    });

    const thirdFailure = buildProfileVerificationTrustUpdate({
      profileId: 'profile-1',
      runId: 'run-3',
      status: 'failed',
      existing: {
        failed_publish_count: 2,
        consecutive_failed_publish_count: 2,
        leaderboard_hidden_at: null,
        last_verified_at: passAfterFailure.last_verified_at,
        last_failed_at: passAfterFailure.last_failed_at,
      },
      now: '2026-06-04T14:00:00.000Z',
    });

    expect(thirdFailure).toMatchObject({
      failed_publish_count: 3,
      consecutive_failed_publish_count: 3,
      deboost_multiplier: 0,
      rank_eligible: false,
      leaderboard_hidden_at: '2026-06-04T14:00:00.000Z',
    });

    const passAfterHidden = buildProfileVerificationTrustUpdate({
      profileId: 'profile-1',
      runId: 'run-4',
      status: 'passed',
      existing: {
        failed_publish_count: thirdFailure.failed_publish_count,
        consecutive_failed_publish_count: thirdFailure.consecutive_failed_publish_count,
        leaderboard_hidden_at: thirdFailure.leaderboard_hidden_at,
        last_verified_at: thirdFailure.last_verified_at,
        last_failed_at: thirdFailure.last_failed_at,
      },
      now: '2026-06-04T15:00:00.000Z',
    });

    expect(passAfterHidden).toMatchObject({
      failed_publish_count: 3,
      consecutive_failed_publish_count: 0,
      deboost_multiplier: 0,
      rank_eligible: false,
      leaderboard_hidden_at: thirdFailure.leaderboard_hidden_at,
      last_verified_at: '2026-06-04T15:00:00.000Z',
    });
  });
});
