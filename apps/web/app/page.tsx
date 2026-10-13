import type { Metadata } from "next";
import { Suspense } from "react";

import type { LeaderboardQuery } from "../../../packages/shared/src/schemas/leaderboard";
import { loadLeaderboard, parseLeaderboardQuery, parseNonProductionDelayMs, waitForMs, type SearchParams } from "./lib/community";
import { CommunitySidebar } from "./components/dashboard/CommunitySidebar";
import { ProjectFooter } from "./components/dashboard/Brand";
const publicSiteUrl = "https://tokensrank.ai";
type HomePageProps = { searchParams?: Promise<SearchParams> };
type LeaderboardState = Awaited<ReturnType<typeof loadLeaderboard>>;

import { apiFetchWithMeta } from "../lib/api";
import { LeaderboardSkeleton } from "../components/leaderboard-skeleton";
import { Info } from "lucide-react";
import { LeaderboardFilters } from "./components/leaderboard-filters";
import { LeaderboardTable as LeaderboardRows } from "./components/LeaderboardTable";
import { Pagination } from "./components/pagination";
import { HomepageHeader } from "./components/homepage/Header";

function LeaderboardTable({
  leaderboard,
  query,
}: {
  leaderboard: LeaderboardState;
  query: LeaderboardQuery;
}) {
  const isDegraded = leaderboard.cacheStatus === "HIT-DEGRADED";

  return (
    <>
      {isDegraded || leaderboard.error ? (
        <div className="rounded-lg border border-tr-warning/50 bg-tr-warning/10 px-4 py-3 text-sm text-tr-warning">
          {isDegraded
            ? "Snapshot is rebuilding. Showing the most recent cached results."
            : leaderboard.error}
        </div>
      ) : null}

      <LeaderboardRows
        rows={leaderboard.rows}
        unavailable={Boolean(leaderboard.error)}
        query={query}
      />

      <Pagination
        currentOffset={query.offset}
        limit={query.limit}
        total={leaderboard.total}
        period={query.period}
        scope={query.scope}
        sort={query.sort}
        order={query.order}
      />
    </>
  );
}

async function LeaderboardTableLoader({
  query,
  delayMs,
}: {
  query: LeaderboardQuery;
  delayMs: number;
}) {
  await waitForMs(delayMs);
  const [leaderboard, recent] = await Promise.all([
    loadLeaderboard(query),
    loadLeaderboard({ ...query, period: "24h", offset: 0, limit: 3, sort: 'cost', order: 'desc' }),
  ]);
  return <div className="dash-community-columns">
    <div className="dash-community-main"><LeaderboardTable leaderboard={leaderboard} query={query} /></div>
    <CommunitySidebar rows={leaderboard.rows} recent={recent.rows} period={query.period} scope={query.scope} unavailable={Boolean(recent.error)} />
  </div>;
}

export async function generateMetadata({
  searchParams,
}: HomePageProps): Promise<Metadata> {
  const resolvedSearchParams = await Promise.resolve(searchParams ?? {});
  const query = parseLeaderboardQuery(resolvedSearchParams);
  const canonical = `${publicSiteUrl}/?period=${encodeURIComponent(query.period)}&scope=${encodeURIComponent(query.scope)}`;

  return {
    alternates: {
      canonical,
    },
    openGraph: {
      url: canonical,
    },
  };
}

async function fetch24hStats() {
  try {
    const response = await apiFetchWithMeta<{
      connected: number;
      tokens24h: number;
      cost24h: number;
      recordsToday: number;
      computedAt: string;
    }>("/api/homepage/stats", { cache: "no-store" });

    return response.data;
  } catch (error) {
    return {
      connected: null,
      tokens24h: null,
      cost24h: null,
      recordsToday: null,
      computedAt: new Date(0).toISOString(),
    };
  }
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const resolvedSearchParams = await Promise.resolve(searchParams ?? {});
  const query = parseLeaderboardQuery(resolvedSearchParams);
  const delayMs = parseNonProductionDelayMs(resolvedSearchParams);
  const stats24h = await fetch24hStats();

  const compact = (value: number | null) =>
    value === null
      ? "—"
      : new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(value);

  return (
    <main className="dashboard dash-market">
      <HomepageHeader />
      <div
        className="dash-market-pulse"
        aria-label="Community activity today (UTC)"
      >
        <div>
          <span className="dash-pulse-label">Community · Today</span>
          <span>
            Active builders <strong>{compact(stats24h.connected)}</strong>
          </span>
          <span>
            Tokens <strong>{compact(stats24h.tokens24h)}</strong>
          </span>
          <span>
            Sessions <strong>{compact(stats24h.recordsToday)}</strong>
          </span>
        </div>
      </div>
      <div className="dash-content dash-market-content">
        <div className="dash-market-title">
          <h1>Leaderboard</h1>
          <details className="dash-ranking-info">
            <summary>
              <Info size={14} /> About the rankings
            </summary>
            <p>
              Rankings default to the highest estimated API value. Click a metric
              column to rank by tokens, sessions or active days, or reverse the order.
              Rank 1 is the highest value for the selected metric.
              GitHub code contributions are optional. Failed code verification can
              lower a profile’s position. Daily totals use UTC; Today starts at midnight.
              API value is an estimate at model API prices, not a subscription bill.
            </p>
          </details>
        </div>
        <section aria-label="AI usage leaderboard">
          <div className="dash-board-controls">
            <LeaderboardFilters
              period={query.period}
              scope={query.scope}
              limit={query.limit}
              sort={query.sort}
              order={query.order}
            />
          </div>
          <Suspense fallback={<LeaderboardSkeleton />}>
            <LeaderboardTableLoader
              key={`${query.period}:${query.scope}:${query.sort}:${query.order}:${query.limit}:${query.offset}:${delayMs}`}
              query={query}
              delayMs={delayMs}
            />
          </Suspense>
        </section>
        <ProjectFooter />
      </div>
    </main>
  );
}
