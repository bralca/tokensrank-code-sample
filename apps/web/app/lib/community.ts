import { LEADERBOARD_LIMIT_MAX, LEADERBOARD_OFFSET_MAX, LeaderboardPeriodSchema, LeaderboardQuerySchema, LeaderboardResponseSchema, LeaderboardScopeSchema, LeaderboardSortSchema, LeaderboardOrderSchema, type LeaderboardQuery, type LeaderboardResponse } from "../../../../packages/shared/src/schemas/leaderboard";
import { apiFetchWithMeta } from "../../lib/api";
export type SearchParams = Record<string, string | string[] | undefined>;

type HomePageProps = {
  searchParams?: Promise<SearchParams>;
};

type LeaderboardApiResponse = {
  data: LeaderboardResponse;
  total?: number;
  cache_status?: string;
};

type LeaderboardState = {
  rows: LeaderboardResponse;
  total: number;
  cacheStatus: string | null;
  error: string | null;
};

const testLeaderboardDelayParam = "__qc_slow_leaderboard_ms";
const maxTestLeaderboardDelayMs = 5000;

function buildLeaderboardPath(query: LeaderboardQuery): string {
  const params = new URLSearchParams({
    period: query.period,
    scope: query.scope,
    limit: String(query.limit),
    offset: String(query.offset),
    sort: query.sort,
    order: query.order,
  });

  return `/api/leaderboard?${params.toString()}`;
}

function firstQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseIntegerQueryValue(
  value: string | string[] | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const rawValue = firstQueryValue(value);

  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsedValue)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, parsedValue));
}

export function parseLeaderboardQuery(searchParams: SearchParams): LeaderboardQuery {
  const query = {
    sort: LeaderboardSortSchema.catch('cost').parse(firstQueryValue(searchParams.sort)),
    order: LeaderboardOrderSchema.catch('desc').parse(firstQueryValue(searchParams.order)),
    period: LeaderboardPeriodSchema.safeParse(
      firstQueryValue(searchParams.period),
    ).success
      ? firstQueryValue(searchParams.period)
      : undefined,
    scope: LeaderboardScopeSchema.safeParse(firstQueryValue(searchParams.scope))
      .success
      ? firstQueryValue(searchParams.scope)
      : undefined,
    limit: parseIntegerQueryValue(
      searchParams.limit,
      LEADERBOARD_LIMIT_MAX,
      1,
      LEADERBOARD_LIMIT_MAX,
    ),
    offset: parseIntegerQueryValue(
      searchParams.offset,
      0,
      0,
      LEADERBOARD_OFFSET_MAX,
    ),
  };

  return LeaderboardQuerySchema.parse(query);
}

export function parseNonProductionDelayMs(searchParams: SearchParams): number {
  if (process.env.NODE_ENV === "production") {
    return 0;
  }

  return parseIntegerQueryValue(
    searchParams[testLeaderboardDelayParam],
    0,
    0,
    maxTestLeaderboardDelayMs,
  );
}

export async function waitForMs(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function fallbackTotal(
  query: LeaderboardQuery,
  rows: LeaderboardResponse,
): number {
  if (rows.length < query.limit) {
    return query.offset + rows.length;
  }

  return query.offset + rows.length + 1;
}

function normalizeLeaderboardResponse(
  response: LeaderboardApiResponse | LeaderboardResponse,
  query: LeaderboardQuery,
): LeaderboardState {
  if (Array.isArray(response)) {
    const rows = LeaderboardResponseSchema.parse(response);

    return {
      rows,
      total: fallbackTotal(query, rows),
      cacheStatus: null,
      error: null,
    };
  }

  const rows = LeaderboardResponseSchema.parse(response.data);

  return {
    rows,
    total: Number.isFinite(response.total)
      ? Math.max(0, Number(response.total))
      : fallbackTotal(query, rows),
    cacheStatus: response.cache_status ?? null,
    error: null,
  };
}

export async function loadLeaderboard(
  query: LeaderboardQuery,
): Promise<LeaderboardState> {
  try {
    const response = await apiFetchWithMeta<
      LeaderboardApiResponse | LeaderboardResponse
    >(buildLeaderboardPath(query), {
      // Keep this SSR fetch uncached in E2E/dev so seeded leaderboard rows do
      // not leak across tests; profile SSR still uses revalidate: 60.
      cache: "no-store",
    });
    const state = normalizeLeaderboardResponse(response.data, query);

    return {
      ...state,
      cacheStatus: state.cacheStatus ?? response.cacheStatus,
    };
  } catch (error) {
    console.warn("[web] Failed to load homepage leaderboard", error);

    return {
      rows: [],
      total: 0,
      cacheStatus: null,
      error:
        "The leaderboard could not be loaded. Please try again in a moment.",
    };
  }
}
