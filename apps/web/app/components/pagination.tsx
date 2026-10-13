import type { LeaderboardPeriod, LeaderboardScope, LeaderboardSort, LeaderboardOrder } from '../../../../packages/shared/src/schemas/leaderboard';
import { leaderboardHref } from '../lib/leaderboard-navigation';

type PaginationProps = {
  currentOffset: number;
  limit: number;
  total: number;
  period: LeaderboardPeriod;
  scope: LeaderboardScope;
  sort?: LeaderboardSort;
  order?: LeaderboardOrder;
};

function pageHref({
  offset,
  limit,
  period,
  scope,
  sort,
  order,
}: {
  offset: number;
  limit: number;
  period: LeaderboardPeriod;
  scope: LeaderboardScope;
  sort: LeaderboardSort;
  order: LeaderboardOrder;
}): string {
  return leaderboardHref({ period, scope, limit, offset: Math.max(0, offset), sort, order });
}

function controlClassName(isDisabled: boolean): string {
  return [
    'inline-flex h-9 min-w-24 items-center justify-center rounded-full border px-4 text-sm font-medium',
    isDisabled
      ? 'cursor-not-allowed border-tr-border bg-tr-bg-soft text-tr-dim'
      : 'border-tr-dim bg-transparent text-tr-secondary hover:border-accent-lime hover:text-accent-lime focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-lime',
  ].join(' ');
}

export function Pagination({
  currentOffset,
  limit,
  total,
  period,
  scope,
  sort = 'cost',
  order = 'desc',
}: PaginationProps) {
  const safeLimit = Math.max(1, limit);
  const safeOffset = Math.max(0, currentOffset);
  const safeTotal = Math.max(0, total);
  const currentPage = safeTotal === 0 ? 1 : Math.floor(safeOffset / safeLimit) + 1;
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit));
  const previousOffset = Math.max(0, safeOffset - safeLimit);
  const nextOffset = safeOffset + safeLimit;
  const hasPrevious = safeOffset > 0;
  const hasNext = nextOffset < safeTotal;

  return (
    <nav
      aria-label="Leaderboard pagination"
      className="flex flex-col gap-3 border-t border-tr-border pt-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid="leaderboard-pagination"
    >
      <p
        className="font-mono text-sm text-tr-secondary"
        data-testid="leaderboard-page-info"
      >
        Page {currentPage} of {totalPages}
      </p>

      <div className="flex gap-2">
        {hasPrevious ? (
          <a
            href={pageHref({
              offset: previousOffset,
              limit: safeLimit,
              period,
              scope,
              sort,
              order,
            })}
            rel="prev"
            className={controlClassName(false)}
            data-testid="leaderboard-prev-link"
          >
            Previous
          </a>
        ) : (
          <button
            type="button"
            disabled
            className={controlClassName(true)}
            data-testid="leaderboard-prev-disabled"
          >
            Previous
          </button>
        )}

        {hasNext ? (
          <a
            href={pageHref({
              offset: nextOffset,
              limit: safeLimit,
              period,
              scope,
              sort,
              order,
            })}
            rel="next"
            className={controlClassName(false)}
            data-testid="leaderboard-next-link"
          >
            Next
          </a>
        ) : (
          <button
            type="button"
            disabled
            className={controlClassName(true)}
            data-testid="leaderboard-next-disabled"
          >
            Next
          </button>
        )}
      </div>
    </nav>
  );
}
