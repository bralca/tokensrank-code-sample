import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeaderboardQuerySchema, type LeaderboardRow } from '../../../../packages/shared/src/schemas/leaderboard';
import { LeaderboardTable } from './LeaderboardTable';
import { Pagination } from './pagination';
import { leaderboardSortHref } from '../lib/leaderboard-navigation';
import { parseLeaderboardQuery } from '../lib/community';

const row: LeaderboardRow = { rank: 1, rank_delta: 0, handle: 'builder', display_name: 'Builder', avatar_url: null, x_handle: null, mode: 'script_verified', tokens_total: 123456, cost_usd_total: 42.25, sessions_count: 12, active_days: 7, badges: [], top_model: 'gpt-5' };
function render(html: string) { const element = document.createElement('div'); element.innerHTML = html; return element; }

describe('sortable leaderboard', () => {
  it('makes API value the default and exposes four sortable metrics with accessible direction', () => {
    const element = render(renderToStaticMarkup(<LeaderboardTable rows={[row]}/>));
    expect(element.querySelector('th[aria-sort="descending"]')?.textContent).toBe('API value');
    expect(element.querySelectorAll('th[aria-sort]')).toHaveLength(4);
    expect(element.querySelector('tbody')?.textContent).toContain('$42.25');
    expect(element.querySelector('tbody')?.textContent).toContain('123.5K');
    expect(element.querySelectorAll('tbody td')[4].textContent).toBe('12');
    expect(element.querySelectorAll('tbody td')[5].textContent).toBe('7');
    expect(element.textContent).toContain('not actual spending');
  });
  it('keeps the selected scope and period, reverses a selected metric, and resets pagination when sorting', () => {
    const query = LeaderboardQuerySchema.parse({ period: '7d', scope: 'codex', sort: 'tokens', order: 'desc', limit: 10, offset: 20 });
    const url = new URL(leaderboardSortHref(query, 'tokens'), 'http://localhost');
    expect(Object.fromEntries(url.searchParams)).toEqual({ period: '7d', scope: 'codex', sort: 'tokens', order: 'asc', limit: '10' });
    expect(leaderboardSortHref({ ...query, order: 'asc' }, 'tokens')).toContain('order=desc');
    expect(leaderboardSortHref(query, 'sessions')).toContain('sort=sessions&order=desc');
    const element = render(renderToStaticMarkup(<Pagination currentOffset={20} limit={10} total={50} period="7d" scope="codex" sort="tokens" order="asc"/>));
    expect(element.querySelector('a[rel="next"]')?.getAttribute('href')).toContain('sort=tokens&order=asc&limit=10&offset=30');
  });
  it('preserves unknown metrics as missing and identifies incomplete pricing', () => {
    const element = render(renderToStaticMarkup(<LeaderboardTable rows={[{ ...row, sessions_count: null, active_days: undefined, api_value_partial: true }]}/>));
    expect(element.querySelectorAll('tbody td')[4].textContent).toBe('—');
    expect(element.querySelectorAll('tbody td')[5].textContent).toBe('—');
    expect(element.textContent).toContain('Partial estimate');
  });
  it('normalizes page queries without forwarding unsupported sort values to the API', () => {
    expect(parseLeaderboardQuery({ sort: 'invalid', order: 'invalid' })).toMatchObject({ sort: 'cost', order: 'desc' });
    expect(parseLeaderboardQuery({ sort: ['active_days'], order: 'asc' })).toMatchObject({ sort: 'active_days', order: 'asc' });
  });
});
