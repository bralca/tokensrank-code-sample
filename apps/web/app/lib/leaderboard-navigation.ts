import { LEADERBOARD_LIMIT_MAX, type LeaderboardQuery, type LeaderboardSort } from '../../../../packages/shared/src/schemas/leaderboard';

export function leaderboardHref(query: LeaderboardQuery): string {
  const params = new URLSearchParams({ period: query.period, scope: query.scope, sort: query.sort, order: query.order });
  if (query.limit !== LEADERBOARD_LIMIT_MAX) params.set('limit', String(query.limit));
  if (query.offset > 0) params.set('offset', String(query.offset));
  return `/?${params}`;
}

export function leaderboardSortHref(query: LeaderboardQuery, sort: LeaderboardSort): string {
  return leaderboardHref({ ...query, sort, order: query.sort === sort && query.order === 'desc' ? 'asc' : 'desc', offset: 0 });
}
