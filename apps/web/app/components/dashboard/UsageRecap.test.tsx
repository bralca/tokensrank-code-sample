import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UsageRecap as Recap, PublicPresence } from '@tokensrank/shared';
import { UsageRecap } from './UsageRecap';
import { PublicPresenceView } from './PublicPresence';

const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-${String(i + 7).padStart(2, '0')}`, tokens: i === 0 ? 200 : 0 }));
const recap: Recap = {
  current: { start: '2026-09-07', end: '2026-09-13', tokens: 200, output_tokens: 50, recorded_days: 1, days },
  previous: { start: '2026-08-31', end: '2026-09-06', tokens: 100, output_tokens: 25, recorded_days: 1, days: days.map(d => ({ date: new Date(Date.parse(d.date) - 7 * 86400000).toISOString().slice(0, 10), tokens: d.tokens / 2 })) },
  comparison: 'ready', change_pct: 100, read_at: '2026-09-14T12:00:00Z', local_tokens_all_time: 500,
  models: [{ model: 'gpt-5', tokens: 200, share: 1, previous_share: .5, change_points: 50 }],
};
const presence: PublicPresence = {
  status: 'available', handle: 'example', profile_url: 'https://community.example/u/example', tokens: 100,
  published_at: '2026-09-13T12:00:00Z', rank: 1, builders: 1,
  standings: [{ kind: 'model', key: 'gpt-5', slug: 'gpt-5', rank: 1, builders: 1 }],
};

describe('visible dashboard recap', () => {
  it('shows complete date ranges, earlier totals, model share changes and their units', () => {
    const html = renderToStaticMarkup(<UsageRecap recap={recap}/>);
    expect(html).toContain('Last 7 complete days'); expect(html).toContain('Sep 7'); expect(html).toContain('Sep 13');
    expect(html).toContain('100% more'); expect(html).toContain('vs 100 in the previous 7 days');
    expect(html).toContain('+50.0 pp vs previous 7 days'); expect(html).toContain('Today is excluded');
    expect(html).toContain('Daily comparison'); expect(html).toContain('Recorded tokens · UTC dates');
  });
  it('explains missing baselines without displaying a made-up growth percentage', () => {
    const html = renderToStaticMarkup(<UsageRecap recap={{ ...recap, comparison: 'short_history', change_pct: null, models: [] }}/>);
    expect(html).toContain('Not enough earlier records'); expect(html).not.toContain('% more');
  });
  it('does not label legacy session dates as a recent daily comparison', () => {
    const html = renderToStaticMarkup(<UsageRecap recap={{ ...recap, comparison: 'legacy_dates', change_pct: null }}/>);
    expect(html).toContain('Daily comparison unavailable'); expect(html).not.toContain('100%');
  });
  it('gives positions a population and points category links at the actual public site', () => {
    const html = renderToStaticMarkup(<PublicPresenceView presence={presence} localTokens={150} onRetry={() => {}}/>);
    expect(html).toContain('of 1 builder'); expect(html).toContain('50 more tokens');
    expect(html).toContain('https://community.example/models/gpt-5?period=all');
    expect(html).toContain('Local changes stay private until you approve a publishing receipt');
    expect(html).toContain('href="/local/publish"');
  });
  it('does not describe lower or equal local totals as unpublished usage', () => {
    const render = (localTokens: number) => renderToStaticMarkup(<PublicPresenceView presence={presence} localTokens={localTokens} onRetry={() => {}}/>);
    expect(render(75)).toContain('25 fewer tokens');
    expect(render(100)).toContain('token totals match');
    expect(render(75)).not.toContain('unpublished usage');
  });
  it('distinguishes unranked, disconnected, loading and unavailable states', () => {
    const render = (value: PublicPresence | null) => renderToStaticMarkup(<PublicPresenceView presence={value} localTokens={500} onRetry={() => {}}/>);
    expect(render({ ...presence, rank: null, standings: [] })).toContain('Not ranked');
    expect(render({ status: 'disconnected' })).toContain('Connect your account');
    expect(render(null)).toContain('Checking your public profile');
    expect(render({ status: 'unavailable' })).toContain('Try again');
    expect(render({ status: 'unavailable' })).not.toContain('#1');
  });
});
