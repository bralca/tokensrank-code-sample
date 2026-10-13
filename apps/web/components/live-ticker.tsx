'use client';

import { useEffect, useMemo, useState } from 'react';

import type { LeaderboardRow } from '../../../packages/shared/src/schemas/leaderboard';

type LiveTickerProps = {
  rows: LeaderboardRow[];
  updatedAt: string;
};

const TICK_INTERVAL_MS = 60_000;
const TOP_BUILDERS_LIMIT = 5;

function formatTokens(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));
  const formats = [
    { value: 1_000_000_000, suffix: 'B' },
    { value: 1_000_000, suffix: 'M' },
    { value: 1_000, suffix: 'K' },
  ] as const;

  for (const format of formats) {
    if (normalized >= format.value) {
      const amount = normalized / format.value;
      return `${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1)}${format.suffix}`;
    }
  }

  return String(normalized);
}

function elapsedLabel(updatedAt: string, now: Date): string {
  const updatedTime = new Date(updatedAt).getTime();

  if (!Number.isFinite(updatedTime)) {
    return 'Updated just now';
  }

  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - updatedTime) / TICK_INTERVAL_MS));

  if (elapsedMinutes < 1) {
    return 'Updated just now';
  }

  return `Updated ${elapsedMinutes} min ago`;
}

export function LiveTicker({ rows, updatedAt }: LiveTickerProps) {
  const [now, setNow] = useState(() => new Date(updatedAt));
  const topBuilders = useMemo(() => rows.slice(0, TOP_BUILDERS_LIMIT), [rows]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(new Date());
    }, TICK_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return (
    <section
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label="Top 5 builders live ticker"
      className="max-w-full overflow-hidden rounded-lg border border-tr-border bg-tr-bg-soft px-2 py-2 sm:px-3 sm:py-2 md:px-4 md:py-3"
      data-testid="live-ticker"
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="line-clamp-1 font-mono text-xs uppercase tracking-[0.12em] text-tr-secondary md:text-sm">
          Top 5 builders ({elapsedLabel(updatedAt, now)})
        </p>
        {topBuilders.length > 0 ? (
          <ol className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-tr-text sm:gap-x-4 md:text-base" aria-label="Top 5 builders">
            {topBuilders.map((row) => (
              <li key={row.handle} className="line-clamp-1 min-w-0 max-w-[9rem] font-mono sm:max-w-none">
                <span className="text-tr-secondary">#{row.rank}</span>{' '}
                <span className="text-tr-text">@{row.handle}</span>{' '}
                <span className="text-tr-accent">{formatTokens(row.tokens_total)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="line-clamp-1 text-xs text-tr-secondary md:text-base">
            No builders have reported usage for this filter yet.
          </p>
        )}
      </div>
    </section>
  );
}
