import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openLocalStore } from './db.js';
import { buildLocalProfile } from './profile.js';
import { rebuildLocalProfileSummary } from './scoring.js';

describe('buildLocalProfile', () => {
  it('applies the requested profile window to headline and summary sections', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-profile-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-04T00:00:00.000Z';
    const nowMs = Date.parse(now);

    try {
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO usage_daily_aggregates (
          date, source, provider, model, total_tokens, input_tokens, output_tokens,
          cache_read_tokens, cache_create_tokens, total_sessions, event_count,
          cost_usd_total, updated_at
        )
        VALUES
          ('2026-06-03', 'codex', 'openai', 'gpt-5.5', 1000, 600, 400, 0, 0, 2, 4, 1.25, ?),
          ('2026-04-01', 'claude', 'anthropic', 'claude-opus-4-7', 3000, 1500, 1500, 0, 0, 3, 6, 3.50, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO usage_session_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          input_tokens, output_tokens, total_tokens, turns, cost_usd_total,
          source_file_hashes_json, updated_at
        )
        VALUES
          ('codex', 'openai', 'recent-1', 'gpt-5.5',
            '2026-06-03T10:00:00.000Z', '2026-06-03T10:10:00.000Z',
            600, 400, 1000, 4, 1.25, '[]', ?),
          ('claude', 'anthropic', 'old-1', 'claude-opus-4-7',
            '2026-04-01T10:00:00.000Z', '2026-04-01T10:30:00.000Z',
            1500, 1500, 3000, 6, 3.50, '[]', ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO ai_threads (
          source, session_id, repo_id, first_event_at, last_event_at,
          total_tokens, metadata_json, updated_at
        )
        VALUES
          ('codex', 'recent-1', 'repo-1', '2026-06-03T10:00:00.000Z', '2026-06-03T10:10:00.000Z', 1000, '{}', ?),
          ('claude', 'old-1', 'repo-1', '2026-04-01T10:00:00.000Z', '2026-04-01T10:30:00.000Z', 3000, '{}', ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO github_code_daily (
          date, repo_id, full_name, prod_branch, github_shipped_loc,
          github_commit_count, verified_at, verification_source, updated_at
        )
        VALUES
          ('2026-06-03', 101, 'owner/repo', 'main', 50, 1, ?, 'github_remote_prod', ?),
          ('2026-04-01', 101, 'owner/repo', 'main', 150, 3, ?, 'github_remote_prod', ?)
      `).run(now, now, now, now);

      rebuildLocalProfileSummary(db, { nowMs });

      const sevenDay = buildLocalProfile(db, { window: '7d', nowMs });
      const all = buildLocalProfile(db, { window: 'all', nowMs });

      expect(sevenDay.window).toBe('7d');
      expect(sevenDay.headline.tokens_total).toBe(1000);
      expect(sevenDay.headline.cost_usd_total).toBe(1.25);
      expect(sevenDay.at_glance.sessions_count).toBe(1);
      expect(sevenDay.cadence.days.find(day => day.date === '2026-06-03')?.sessions_count).toBe(1);
      expect(all.cadence.days.reduce((sum, day) => sum + day.sessions_count, 0)).toBe(2);
      expect(sevenDay.at_glance.days_active).toBe(1);
      expect(sevenDay.at_glance.window_stats.median_session).toBe('10m');
      expect(sevenDay.models.items.map((item) => item.label)).toEqual(['gpt-5.5']);
      expect(sevenDay.tools.codex_pct_tokens).toBe(1);
      expect(sevenDay.tools.claude_pct_tokens).toBe(0);
      expect(sevenDay.cadence.score_per_day_90d.some((score) => score > 0)).toBe(true);
      expect(sevenDay.cadence.score_per_day_90d).toHaveLength(sevenDay.cadence.daily_tokens_90d.length);
      expect(sevenDay.shipped?.loc_per_day_90d).toHaveLength(sevenDay.cadence.daily_tokens_90d.length);
      expect(sevenDay.shipped?.produced_loc_per_day_90d).toHaveLength(sevenDay.cadence.daily_tokens_90d.length);
      expect(sevenDay.shipped?.produced_shipped_loc_per_day_90d).toHaveLength(sevenDay.cadence.daily_tokens_90d.length);
      expect(sevenDay.cadence.windows?.['7d']).toMatchObject({
        busiest_day: 'Wednesday',
        busiest_hour: '10:00',
        sessions_count: 1,
        weekend_share: 0,
        after_midnight: { count: 0, pct: 0 },
      });

      expect(all.window).toBe('all');
      expect(all.headline.tokens_total).toBe(4000);
      expect(all.headline.cost_usd_total).toBe(4.75);
      expect(all.at_glance.sessions_count).toBe(2);
      expect(all.at_glance.days_active).toBe(2);
      expect(all.models.items.map((item) => item.label)).toEqual([
        'claude-opus-4-7',
        'gpt-5.5',
      ]);
      expect(all.cadence.windows?.['30d']?.sessions_count).toBe(1);
      expect(all.cadence.windows?.all?.sessions_count).toBe(2);
      db.prepare(`INSERT INTO usage_session_rollups
        (source, provider, session_id, model, first_event_at, last_event_at, source_file_hashes_json, updated_at)
        VALUES ('codex', 'openai', 'outside-calendar-window', 'gpt-5.5', '2026-05-28T12:00:00.000Z', '2026-05-28T12:10:00.000Z', '[]', ?)`)
        .run(now);
      const bounded = buildLocalProfile(db, { window: '7d', nowMs });
      expect(bounded.at_glance.sessions_count).toBe(1);
      expect(bounded.cadence.days.slice(-7).reduce((total, day) => total + day.sessions_count, 0)).toBe(1);

    } finally {
      store.close();
    }
  });

  it('uses top model totals, not first-seen row order, for model history', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-profile-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-04T00:00:00.000Z';
    const nowMs = Date.parse(now);

    try {
      const insertDaily = db.prepare(`
        INSERT INTO usage_daily_aggregates (
          date, source, provider, model, total_tokens, input_tokens, output_tokens,
          cache_read_tokens, cache_create_tokens, total_sessions, event_count,
          cost_usd_total, updated_at
        )
        VALUES (?, 'codex', 'openai', ?, ?, ?, ?, 0, 0, 1, 1, ?, ?)
      `);

      for (let index = 0; index < 13; index += 1) {
        insertDaily.run('2026-05-01', `early-${index}`, 10, 5, 5, 0.01, now);
      }

      insertDaily.run('2026-06-03', 'gpt-5.5', 1000000, 600000, 400000, 100, now);

      const profile = buildLocalProfile(db, { window: 'all', nowMs });

      expect(profile.models.models[0]?.name).toBe('gpt-5.5');
      expect(profile.models.model_usage_history[0]?.model).toBe('gpt-5.5');
      expect(profile.models.model_usage_history).toHaveLength(12);
      expect(profile.models.model_usage_history[0]?.points.at(-1)).toMatchObject({
        tokens: 1000000,
        cost: 100,
      });
    } finally {
      store.close();
    }
  });

  it('shows OpenCode usage, strict model-code LOC, and zero-LOC efficiency diagnostics', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-profile-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-04T00:00:00.000Z';
    const nowMs = Date.parse(now);

    try {
      db.prepare(`
        INSERT INTO usage_daily_aggregates (
          date, source, provider, model, total_tokens, input_tokens, output_tokens,
          cache_read_tokens, cache_create_tokens, total_sessions, event_count,
          cost_usd_total, updated_at
        )
        VALUES
          ('2026-06-02', 'opencode', 'unknown', 'deepseek-chat-v3', 1000, 600, 400, 0, 0, 1, 2, 0.50, ?),
          ('2026-06-03', 'opencode', 'unknown', 'deepseek-chat-v3', 5000, 3000, 2000, 0, 0, 1, 2, 2.50, ?),
          ('2026-06-04', 'opencode', 'unknown', 'deepseek-chat-v3', 1000, 700, 300, 0, 0, 1, 2, 1.00, ?)
      `).run(now, now, now);
      db.prepare(`
        INSERT INTO usage_session_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          input_tokens, output_tokens, total_tokens, turns, cost_usd_total,
          source_file_hashes_json, updated_at
        )
        VALUES ('opencode', 'unknown', 'open-1', 'deepseek-chat-v3',
          '2026-06-03T10:00:00.000Z', '2026-06-03T10:10:00.000Z',
          3000, 2000, 5000, 2, 2.50, '[]', ?)
      `).run(now);
      db.prepare(`
        INSERT INTO code_daily_rollups (
          date, produced_loc, produced_loc_score, shipped_loc, shipped_loc_score,
          ai_linked_commit_count, high_confidence_commit_count, median_link_confidence, updated_at
        )
        VALUES
          ('2026-06-03', 120, 120, 40, 40, 1, 1, 0.9, ?),
          ('2026-06-04', 0, 0, 0, 0, 0, 0, 0, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO ai_code_model_daily (
          date, source, provider, model, produced_loc, produced_loc_score,
          shipped_loc, shipped_loc_score, linked_commit_count, linked_tokens,
          linked_cost_usd, updated_at
        )
        VALUES ('2026-06-03', 'opencode', 'unknown', 'deepseek-chat-v3',
          120, 120, 40, 40, 1, 5000, 2.50, ?)
      `).run(now);

      const profile = buildLocalProfile(db, { window: '30d', nowMs });

      expect(profile.headline.tokens_total).toBe(7000);
      expect(profile.headline.cost_usd_total).toBe(4);
      expect(profile.models.provider_spend_history.some((series) => series.provider === 'opencode')).toBe(true);
      const opencodeSpend = profile.models.provider_spend_history.find((series) => series.provider === 'opencode');
      expect(opencodeSpend?.points.at(-1)).toMatchObject({ cost: 4 });
      const opencodeUsage = profile.models.model_usage_history.find((series) => series.model === 'deepseek-chat-v3');
      expect(opencodeUsage?.points.at(-1)).toMatchObject({ tokens: 7000 });
      expect(profile.models.model_code_breakdown[0]).toMatchObject({
        source: 'opencode',
        model: 'deepseek-chat-v3',
        tokens_total: 7000,
        cost_usd_total: 4,
        ai_coded_loc: 120,
        shipped_ai_coded_loc: 40,
      });
      expect(profile.shipped?.produced_loc_total).toBe(120);
      expect(profile.shipped?.produced_shipped_loc_total).toBe(40);
      expect(profile.shipped?.spend_per_shipped_ai_loc_30d.find((point) => point.date === '2026-06-02')).toMatchObject({
        cost_usd: 0.5,
        shipped_ai_coded_loc: 0,
        value: null,
        status: 'no_shipped_code',
      });
      const lastEfficiency = profile.shipped?.spend_per_shipped_ai_loc_30d.at(-1);
      expect(lastEfficiency).toMatchObject({
        cost_usd: 4,
        shipped_ai_coded_loc: 40,
        value: 0.1,
        status: 'ok',
      });
    } finally {
      store.close();
    }
  });
});
