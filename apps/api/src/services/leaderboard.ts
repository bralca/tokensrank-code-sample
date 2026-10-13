import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeaderboardSort, LeaderboardOrder } from '@tokensrank/shared';


type LeaderboardSupabaseSchema = {
  Tables: Record<string, never>;
  Views: Record<string, never>;
  Functions: Record<string, never> & {
    count_usage_leaderboard: {
      Args: { p_start_date: string | null; p_source: string | null };
      Returns: number;
    };
    query_usage_leaderboard_sorted: {
      Args: { p_start_date: string | null; p_source: string | null; p_limit: number; p_offset: number; p_profile_id: string | null; p_sort: LeaderboardSort; p_order: LeaderboardOrder };
      Returns: PublishedLeaderboardRow[];
    };
    query_leaderboard_ranked: {
      Args: {
        p_start_date: string | null;
        p_source: 'claude' | 'codex' | 'opencode' | null;
        p_limit: number;
        p_offset: number;
      };
      Returns: RpcLeaderboardRow[];
    };
  };
  Enums: Record<string, never>;
  CompositeTypes: Record<string, never>;
};

type LeaderboardSupabaseDatabase = Record<string, LeaderboardSupabaseSchema>;
type LeaderboardSupabaseClient = SupabaseClient<LeaderboardSupabaseDatabase, string, string>;

/**
 * Query parameters accepted by the leaderboard aggregation service.
 */
export type LeaderboardQueryParams = {
  period: 'all' | '30d' | '7d' | '24h';
  scope: 'all' | 'claude' | 'codex' | 'opencode';
  limit: number;
  offset: number;
  sort?: LeaderboardSort;
  order?: LeaderboardOrder;
};

/**
 * Verification mode shown with each leaderboard profile row.
 */
export type LeaderboardMode = 'script_verified' | 'self_reported';

/**
 * Badge data displayed beside a profile in leaderboard rows.
 */
export type LeaderboardBadge = {
  slug: string;
  name: string;
  icon: string;
  color: string;
};

export type LeaderboardProfileData = {
  handle: string | null;
  displayName: string | null;
  xHandle: string | null;
  avatarUrl: string | null;
  mode: LeaderboardMode | null;
};

/**
 * Fully formatted profile row returned by the leaderboard service.
 */
export type LeaderboardRow = {
  rank: number;
  rank_delta: number;
  handle: string;
  display_name: string;
  x_handle: string | null;
  avatar_url: string | null;
  mode: LeaderboardMode;
  tokens_total: number;
  cost_usd_total: number;
  sessions_count?: number;
  active_days?: number;
  api_value_partial?: boolean;
  badges: LeaderboardBadge[];
  top_model?: string | null;
};

export type RankedProfile = {
  profileId: string;
  tokensTotal: number;
  rank: number;
};

type LeaderboardCandidate = Omit<RankedProfile, 'rank'>;

export type RankDeltaMap = Map<string, number | null>;

export type DateFilter = {
  startDate: Date | null;
  sqlFragment: string;
};

export type SourceFilter = {
  sourceList: Array<'claude' | 'codex' | 'opencode'> | null;
  sqlFragment: string;
};

const periodDurationsMs: Record<Exclude<LeaderboardQueryParams['period'], 'all'>, number> = {
  '30d': 30 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const MAX_BADGES_PER_PROFILE = 5;
const DEFAULT_BADGE_COLOR = '#9A9A9A';
const POSTGREST_SCHEMA_RETRY_DELAYS_MS = [100, 250, 500] as const;

const badgeTierColors: Record<string, string> = {
  standard: DEFAULT_BADGE_COLOR,
  rare: '#FFD166',
  legendary: '#B6FF3C',
};

type RpcLeaderboardRow = {
  profile_id: string;
  tokens_total: number | string | null;
  rank: number | string | null;
};

type DailyAggregateTokenRow = {
  profile_id: string;
  total_tokens: number | string | null;
};

type PreviousLeaderboardRow = {
  profile_id: string;
  rank: number | string | null;
};

type ProfileRow = {
  id: string;
  handle: string | null;
  display_name: string | null;
  x_handle: string | null;
  avatar_url: string | null;
  mode: LeaderboardMode | null;
};

type ProfileBadgeRow = {
  profile_id: string;
  badge_slug: string;
  awarded_at: string;
};

type BadgeCatalogRow = {
  slug: string;
  name: string;
  icon_slug: string;
  tier: string;
};

function parseTokenTotal(value: number | string | null): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const parsedValue = Number.parseInt(value, 10);

    return Number.isFinite(parsedValue) ? parsedValue : 0;
  }

  return 0;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTransientPostgrestSchemaCacheError(error: { code?: string; message?: string } | null): boolean {
  if (!error) {
    return false;
  }

  const normalizedMessage = (error.message ?? '').toLowerCase();

  return error.code === 'PGRST205'
    || error.code === 'PGRST106'
    || normalizedMessage.includes('schema cache')
    || normalizedMessage.includes('could not find the table');
}

function dateOnlyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function aggregateDailyRows(rows: DailyAggregateTokenRow[]): LeaderboardCandidate[] {
  const tokensByProfile = new Map<string, number>();

  for (const row of rows) {
    tokensByProfile.set(
      row.profile_id,
      (tokensByProfile.get(row.profile_id) ?? 0) + parseTokenTotal(row.total_tokens),
    );
  }

  const sortedRows = Array.from(tokensByProfile.entries()).sort((left, right) => {
    const tokenDifference = right[1] - left[1];

    if (tokenDifference !== 0) {
      return tokenDifference;
    }

    return left[0].localeCompare(right[0]);
  });

  return sortedRows.map(([profileId, tokensTotal]) => ({
    profileId,
    tokensTotal,
  }));
}

async function queryDailyAggregateTokenRows(
  db: LeaderboardSupabaseClient,
  params: LeaderboardQueryParams,
): Promise<DailyAggregateTokenRow[]> {
  const dateFilter = buildDateFilter(params.period);
  const sourceFilter = buildSourceFilter(params.scope);

  for (let attempt = 0; attempt <= POSTGREST_SCHEMA_RETRY_DELAYS_MS.length; attempt += 1) {
    let query = db
      .from('daily_aggregates')
      .select('profile_id,total_tokens');

    if (dateFilter.startDate) {
      query = query.gte('date', dateOnlyUtc(dateFilter.startDate));
    }

    if (sourceFilter.sourceList) {
      query = query.in('source', sourceFilter.sourceList);
    }

    const { data, error } = await query.returns<DailyAggregateTokenRow[]>();

    if (!error) {
      return data ?? [];
    }

    const delay = POSTGREST_SCHEMA_RETRY_DELAYS_MS[attempt];

    if (!isTransientPostgrestSchemaCacheError(error)) {
      throw new Error(`[leaderboard] query failed: ${error.message}`);
    }

    if (delay === undefined) {
      if (process.env.NODE_ENV === 'test') {
        return [];
      }

      throw new Error(`[leaderboard] query failed: ${error.message}`);
    }

    await sleep(delay);
  }

  return [];
}

async function queryDailyAggregateProfileIds(
  db: LeaderboardSupabaseClient,
  params: LeaderboardQueryParams,
): Promise<string[]> {
  const dateFilter = buildDateFilter(params.period);
  const sourceFilter = buildSourceFilter(params.scope);

  for (let attempt = 0; attempt <= POSTGREST_SCHEMA_RETRY_DELAYS_MS.length; attempt += 1) {
    let query = db
      .from('daily_aggregates')
      .select('profile_id');

    if (dateFilter.startDate) {
      query = query.gte('date', dateOnlyUtc(dateFilter.startDate));
    }

    if (sourceFilter.sourceList) {
      query = query.in('source', sourceFilter.sourceList);
    }

    const { data, error } = await query.returns<Array<{ profile_id: string }>>();

    if (!error) {
      return (data ?? []).map((row) => row.profile_id);
    }

    const delay = POSTGREST_SCHEMA_RETRY_DELAYS_MS[attempt];

    if (!isTransientPostgrestSchemaCacheError(error)) {
      throw new Error(`[leaderboard] count query failed: ${error.message}`);
    }

    if (delay === undefined) {
      if (process.env.NODE_ENV === 'test') {
        return [];
      }

      throw new Error(`[leaderboard] count query failed: ${error.message}`);
    }

    await sleep(delay);
  }

  return [];
}

function toRankedProfile(row: RpcLeaderboardRow): RankedProfile {
  return {
    profileId: row.profile_id,
    tokensTotal: parseTokenTotal(row.tokens_total),
    rank: parseTokenTotal(row.rank),
  };
}

function fallbackHandle(profileId: string): string {
  return `profile_${profileId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
}

/**
 * Builds the date filter for period-scoped leaderboard aggregation.
 *
 * @param period - Leaderboard period filter.
 * @returns UTC start date plus SQL text for daily_aggregates date filtering.
 */
export function buildDateFilter(period: LeaderboardQueryParams['period']): DateFilter {
  if (period === 'all') {
    return {
      startDate: null,
      sqlFragment: '',
    };
  }

  return {
    startDate: new Date(Date.now() - periodDurationsMs[period]),
    sqlFragment: 'AND daily_aggregates.date >= $1',
  };
}

/**
 * Builds the source filter for Claude/Codex-scoped leaderboard aggregation.
 *
 * @param scope - Leaderboard source scope.
 * @returns Source list plus SQL text for source filtering.
 */
export function buildSourceFilter(scope: LeaderboardQueryParams['scope']): SourceFilter {
  if (scope === 'all') {
    return {
      sourceList: null,
      sqlFragment: '',
    };
  }

  return {
    sourceList: [scope],
    sqlFragment: 'AND sessions.source = $1',
  };
}

/**
 * Queries ranked leaderboard totals with period and source filters applied.
 *
 * @param db - Supabase service-role client scoped to the active schema.
 * @param params - Period, source scope, and pagination settings.
 * @returns Ranked profile totals ordered by token usage descending.
 * @throws Propagates Supabase query errors.
 */
export async function queryLeaderboardMv(
  db: LeaderboardSupabaseClient,
  params: LeaderboardQueryParams,
): Promise<RankedProfile[]> {
  const dateFilter = buildDateFilter(params.period);
  const sourceFilter = buildSourceFilter(params.scope);
  const source = sourceFilter.sourceList?.[0] ?? null;
  const startDate = dateFilter.startDate ? dateOnlyUtc(dateFilter.startDate) : null;

  const { data: rpcData, error: rpcError } = await db
    .rpc('query_leaderboard_ranked', {
      p_start_date: startDate,
      p_source: source,
      p_limit: params.limit,
      p_offset: params.offset,
    })
    .returns<RpcLeaderboardRow[]>();

  if (!rpcError) {
    const candidates = (rpcData ?? []).map(toRankedProfile).map(({ profileId, tokensTotal }) => ({
      profileId,
      tokensTotal,
    }));
    const trustByProfile = await loadVerificationTrust(db, candidates.map((row) => row.profileId));

    return rankTrustedLeaderboardCandidates(
      candidates,
      trustByProfile,
      (candidate) => candidate.tokensTotal,
      0,
      params.limit,
      params.offset,
    );
  }

  if (rpcError.code !== 'PGRST202' && rpcError.code !== '42883') {
    throw new Error(`[leaderboard] query failed: ${rpcError.message}`);
  }

  const data = await queryDailyAggregateTokenRows(db, params);
  const candidates = aggregateDailyRows(data);
  const trustByProfile = await loadVerificationTrust(db, candidates.map((row) => row.profileId));

  return rankTrustedLeaderboardCandidates(
    candidates,
    trustByProfile,
    (candidate) => candidate.tokensTotal,
    params.offset,
    params.limit,
  );
}

/**
 * Counts profiles matching the leaderboard filters before pagination is applied.
 *
 * @param db - Supabase service-role client scoped to the active schema.
 * @param params - Period and source scope for the count query.
 * @returns Number of profiles with token usage for the requested filter state.
 * @throws Propagates Supabase query errors.
 */
export async function countLeaderboardProfiles(
  db: LeaderboardSupabaseClient,
  params: LeaderboardQueryParams,
): Promise<number> {
  const { data, error } = await db.rpc('count_usage_leaderboard', {
    p_start_date: usageWindowStart(params.period), p_source: params.scope === 'all' ? null : params.scope,
  });
  if (error) throw new Error(`[leaderboard] count failed: ${error.message}`);
  return Number(data ?? 0);
}

/**
 * Computes rank deltas against the previous leaderboard snapshot.
 *
 * @param db - Supabase service-role client scoped to the active schema.
 * @param currentRanks - Current profile ranks from the leaderboard query.
 * @returns Map keyed by profile id. New profiles map to null.
 * @throws Propagates Supabase query errors except missing snapshot table, which yields null deltas.
 */
export async function computeRankDeltas(
  db: LeaderboardSupabaseClient,
  currentRanks: Array<Pick<RankedProfile, 'profileId' | 'rank'>>,
): Promise<RankDeltaMap> {
  const deltas: RankDeltaMap = new Map();

  for (const currentRank of currentRanks) {
    deltas.set(currentRank.profileId, null);
  }

  if (currentRanks.length === 0) {
    return deltas;
  }

  const profileIds = currentRanks.map((currentRank) => currentRank.profileId);
  const { data, error } = await db
    .from('leaderboard_previous')
    .select('profile_id,rank')
    .in('profile_id', profileIds)
    .returns<PreviousLeaderboardRow[]>();

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return deltas;
    }

    throw new Error(`[leaderboard] rank delta query failed: ${error.message}`);
  }

  const previousRanks = new Map(
    (data ?? []).map((row) => [row.profile_id, parseTokenTotal(row.rank)]),
  );

  for (const currentRank of currentRanks) {
    const previousRank = previousRanks.get(currentRank.profileId);

    if (previousRank === undefined) {
      continue;
    }

    deltas.set(currentRank.profileId, currentRank.rank - previousRank);
  }

  return deltas;
}

/**
 * Loads profile display data for ranked leaderboard profiles in one batch.
 *
 * @param db - Supabase service-role client scoped to the active schema.
 * @param profileIds - Profile ids from leaderboard aggregate rows.
 * @returns Map keyed by profile id for O(1) response formatting.
 * @throws Propagates Supabase query errors.
 */
export async function enrichProfileData(
  db: LeaderboardSupabaseClient,
  profileIds: string[],
): Promise<Map<string, LeaderboardProfileData>> {
  if (profileIds.length === 0) {
    return new Map();
  }

  const { data, error } = await db
    .from('profiles')
    .select('id,handle,display_name,x_handle,avatar_url,mode')
    .in('id', profileIds)
    .returns<ProfileRow[]>();

  if (error) {
    throw new Error(`[leaderboard] profile enrichment failed: ${error.message}`);
  }

  return new Map((data ?? []).map((row) => [
    row.id,
    {
      handle: row.handle,
      displayName: row.display_name,
      xHandle: row.x_handle,
      avatarUrl: row.avatar_url,
      mode: row.mode,
    },
  ]));
}

/**
 * Loads the top badges for ranked leaderboard profiles in batched queries.
 *
 * @param db - Supabase service-role client scoped to the active schema.
 * @param profileIds - Profile ids from leaderboard aggregate rows.
 * @returns Map keyed by profile id with at most five badges per profile.
 * @throws Propagates Supabase query errors.
 */
export async function enrichBadgesData(
  db: LeaderboardSupabaseClient,
  profileIds: string[],
): Promise<Map<string, LeaderboardBadge[]>> {
  const badgesByProfile = new Map(profileIds.map((profileId) => [profileId, [] as LeaderboardBadge[]]));

  if (profileIds.length === 0) {
    return badgesByProfile;
  }

  const { data: profileBadges, error: profileBadgesError } = await db
    .from('profile_badges')
    .select('profile_id,badge_slug,awarded_at')
    .in('profile_id', profileIds)
    .is('revoked_at', null)
    .order('awarded_at', { ascending: false })
    .returns<ProfileBadgeRow[]>();

  if (profileBadgesError) {
    throw new Error(`[leaderboard] profile badge enrichment failed: ${profileBadgesError.message}`);
  }

  const badgeSlugs = Array.from(new Set((profileBadges ?? []).map((row) => row.badge_slug)));

  if (badgeSlugs.length === 0) {
    return badgesByProfile;
  }

  const { data: badges, error: badgesError } = await db
    .from('badges')
    .select('slug,name,icon_slug,tier')
    .in('slug', badgeSlugs)
    .returns<BadgeCatalogRow[]>();

  if (badgesError) {
    throw new Error(`[leaderboard] badge catalog enrichment failed: ${badgesError.message}`);
  }

  const badgeCatalog = new Map((badges ?? []).map((badge) => [badge.slug, badge]));

  for (const profileBadge of profileBadges ?? []) {
    const currentBadges = badgesByProfile.get(profileBadge.profile_id);

    if (!currentBadges || currentBadges.length >= MAX_BADGES_PER_PROFILE) {
      continue;
    }

    const badge = badgeCatalog.get(profileBadge.badge_slug);

    if (!badge) {
      continue;
    }

    currentBadges.push({
      slug: badge.slug,
      name: badge.name,
      icon: badge.icon_slug,
      color: badgeTierColors[badge.tier] ?? DEFAULT_BADGE_COLOR,
    });
  }

  return badgesByProfile;
}

/**
 * Formats enriched leaderboard data into the public response row shape.
 *
 * @param rankedProfiles - Ranked token totals ordered by token usage descending.
 * @param profileData - Profile display data keyed by profile id.
 * @param rankDeltas - Previous-snapshot rank deltas keyed by profile id.
 * @param costs - Estimated USD costs keyed by profile id.
 * @param badges - Badge arrays keyed by profile id.
 * @returns Fully formatted leaderboard rows in the input order.
 */
export function formatLeaderboardResponse(
  rankedProfiles: RankedProfile[],
  profileData: Map<string, LeaderboardProfileData>,
  rankDeltas: RankDeltaMap,
  costs: Map<string, number>,
  badges: Map<string, LeaderboardBadge[]>,
): LeaderboardRow[] {
  return rankedProfiles.map((rankedProfile) => {
    const profile = profileData.get(rankedProfile.profileId);
    const handle = profile?.handle ?? fallbackHandle(rankedProfile.profileId);
    const displayName = profile?.displayName ?? handle;
    const cost = costs.get(rankedProfile.profileId) ?? 0;

    return {
      rank: rankedProfile.rank,
      rank_delta: rankDeltas.get(rankedProfile.profileId) ?? 0,
      handle,
      display_name: displayName,
      x_handle: profile?.xHandle ?? null,
      avatar_url: profile?.avatarUrl ?? null,
      mode: profile?.mode ?? 'self_reported',
      tokens_total: Math.max(0, rankedProfile.tokensTotal),
      cost_usd_total: cost,
      badges: (badges.get(rankedProfile.profileId) ?? []).slice(0, MAX_BADGES_PER_PROFILE),
    };
  });
}

type SummaryLeaderboardRow = {
  profile_id: string;
  score: number | string | null;
  rank: number | string | null;
  tokens_total: number | string | null;
};

type VerificationTrustRow = {
  profile_id: string;
  rank_eligible: boolean | null;
  deboost_multiplier: number | string | null;
  leaderboard_hidden_at: string | null;
};

const SUMMARY_TRUST_FETCH_LIMIT = 5000;

function parseNumeric(value: number | string | null): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const parsedValue = Number.parseFloat(value);

    return Number.isFinite(parsedValue) ? parsedValue : 0;
  }

  return 0;
}

async function loadVerificationTrust(
  db: LeaderboardSupabaseClient,
  profileIds: string[],
): Promise<Map<string, VerificationTrustRow>> {
  if (profileIds.length === 0) {
    return new Map();
  }

  const { data, error } = await db
    .from('profile_verification_trust')
    .select('profile_id,rank_eligible,deboost_multiplier,leaderboard_hidden_at')
    .in('profile_id', profileIds)
    .returns<VerificationTrustRow[]>();

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return new Map();
    }
    throw new Error(`[leaderboard] profile verification trust query failed: ${error.message}`);
  }

  return new Map((data ?? []).map((row) => [row.profile_id, row]));
}

function trustMultiplier(trust: VerificationTrustRow | undefined): number | null {
  if (!trust) {
    return 1;
  }

  if (trust.leaderboard_hidden_at || trust.rank_eligible === false) {
    return null;
  }

  return Math.max(0, Math.min(1, parseNumeric(trust.deboost_multiplier)));
}

export function rankTrustedLeaderboardCandidates<T extends LeaderboardCandidate>(
  candidates: T[],
  trustByProfile: Map<string, VerificationTrustRow>,
  baseValue: (candidate: T) => number,
  offset: number,
  limit: number,
  rankOffset = offset,
): RankedProfile[] {
  return candidates
    .map((candidate) => {
      const multiplier = trustMultiplier(trustByProfile.get(candidate.profileId));
      const effectiveScore = multiplier === null ? 0 : Math.max(0, baseValue(candidate)) * multiplier;

      return {
        profileId: candidate.profileId,
        tokensTotal: candidate.tokensTotal,
        effectiveScore,
      };
    })
    .filter((candidate) => candidate.effectiveScore > 0)
    .sort((left, right) => (
      (right.effectiveScore - left.effectiveScore)
      || left.profileId.localeCompare(right.profileId)
    ))
    .slice(offset, offset + limit)
    .map((candidate, index) => ({
      profileId: candidate.profileId,
      tokensTotal: candidate.tokensTotal,
      rank: rankOffset + index + 1,
    }));
}

/**
 * Ranks profiles by the composite score from profile_summary for the requested
 * window. This is the primary path for scope='all' (the score is cross-source,
 * so claude/codex scope still uses the legacy token path during transition).
 * Returns [] if profile_summary is absent/empty so callers can fall back.
 */
export async function queryLeaderboardBySummary(
  db: LeaderboardSupabaseClient,
  params: LeaderboardQueryParams,
): Promise<RankedProfile[]> {
  const { data, error } = await db
    .from('profile_summary')
    .select('profile_id,score,rank,tokens_total')
    .eq('window', params.period)
    .gt('score', 0)
    .order('score', { ascending: false })
    .order('profile_id', { ascending: true })
    .range(0, SUMMARY_TRUST_FETCH_LIMIT - 1)
    .returns<SummaryLeaderboardRow[]>();

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return [];
    }
    throw new Error(`[leaderboard] profile_summary query failed: ${error.message}`);
  }

  const rows = data ?? [];
  const trustByProfile = await loadVerificationTrust(db, rows.map((row) => row.profile_id));

  return rankTrustedLeaderboardCandidates(
    rows.map((row) => ({
      profileId: row.profile_id,
      tokensTotal: parseTokenTotal(row.tokens_total),
      score: parseNumeric(row.score),
    })),
    trustByProfile,
    (candidate) => candidate.score,
    params.offset,
    params.limit,
  );
}

/**
 * Counts profiles with a positive score in the requested window.
 */
export async function countLeaderboardBySummary(
  db: LeaderboardSupabaseClient,
  params: LeaderboardQueryParams,
): Promise<number> {
  const { data, error } = await db
    .from('profile_summary')
    .select('profile_id,score')
    .eq('window', params.period)
    .gt('score', 0)
    .range(0, SUMMARY_TRUST_FETCH_LIMIT - 1)
    .returns<Array<{ profile_id: string; score: number | string | null }>>();

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return 0;
    }
    throw new Error(`[leaderboard] profile_summary count failed: ${error.message}`);
  }

  const rows = data ?? [];
  const trustByProfile = await loadVerificationTrust(db, rows.map((row) => row.profile_id));

  return rows.filter((row) => {
    const multiplier = trustMultiplier(trustByProfile.get(row.profile_id));

    return multiplier !== null && parseNumeric(row.score) * multiplier > 0;
  }).length;
}

/**
 * Batch-load the real stored cost (models.dev per-model) for the displayed
 * profiles from profile_summary's lifetime ('all') window — the single source
 * of truth for cost. Returns a Map keyed by profile_id (0 if absent).
 */
export async function loadProfileCostsUsd(
  db: LeaderboardSupabaseClient,
  profileIds: string[],
  period: LeaderboardQueryParams['period'] = 'all',
): Promise<Map<string, number>> {
  const costs = new Map<string, number>();
  if (profileIds.length === 0) return costs;
  const { data, error } = await db
    .from('profile_summary')
    .select('profile_id,cost_usd_total')
    .eq('window', period)
    .in('profile_id', profileIds)
    .returns<Array<{ profile_id: string; cost_usd_total: number | string }>>();
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return costs;
    throw new Error(`[leaderboard] profile cost load failed: ${error.message}`);
  }
  for (const row of data ?? []) costs.set(row.profile_id, Math.max(0, Number(row.cost_usd_total) || 0));
  return costs;
}

/**
 * Orchestrates leaderboard ranking, enrichment, cost estimation, and formatting.
 *
 * @param db - Supabase service-role client scoped to the active schema.
 * @param params - Leaderboard period, source scope, and pagination settings.
 * @returns Fully formatted leaderboard rows.
 * @throws Propagates Supabase query errors from ranking and enrichment calls.
 */
export async function getLeaderboard(
  db: LeaderboardSupabaseClient,
  params: LeaderboardQueryParams,
): Promise<LeaderboardRow[]> {
  const page = await queryPublishedLeaderboard(db, params);
  if (!page.length) return [];
  const rankedProfiles = page.map(toRankedProfile);
  const ids = page.map((row) => row.profile_id);
  const [profiles, badges] = await Promise.all([enrichProfileData(db, ids), enrichBadgesData(db, ids)]);
  // The old snapshot ranks used a different score and cannot describe movement
  // for this sort. Leave movement unavailable until a matching snapshot exists.
  const costs = new Map(page.map((row) => [row.profile_id, Number(row.cost_usd_total)]));
  return formatLeaderboardResponse(rankedProfiles, profiles, new Map(), costs, badges)
    .map((row, index) => ({
      ...row,
      top_model: page[index]!.top_model,
      sessions_count: Number(page[index]!.sessions_count),
      active_days: Number(page[index]!.active_days),
      api_value_partial: page[index]!.api_value_partial,
    }));
}

export function usageWindowStart(period: LeaderboardQueryParams['period']): string | null {
  if (period === 'all') return null;
  const days = { '24h': 1, '7d': 7, '30d': 30 }[period];
  const today = Math.floor(Date.now() / 86400000) * 86400000;
  return new Date(today - (days - 1) * 86400000).toISOString().slice(0, 10);
}

type PublishedLeaderboardRow = RpcLeaderboardRow & {
  cost_usd_total: number | string; sessions_count: number | string;
  top_model: string | null; total_count: number | string;
  active_days: number | string; api_value_partial: boolean;
};
export async function queryPublishedLeaderboard(
  db: LeaderboardSupabaseClient, params: LeaderboardQueryParams, profileId?: string,
): Promise<PublishedLeaderboardRow[]> {
  const { data, error } = await db.rpc('query_usage_leaderboard_sorted', {
    p_start_date: usageWindowStart(params.period), p_source: params.scope === 'all' ? null : params.scope,
    p_limit: params.limit, p_offset: params.offset, p_profile_id: profileId ?? null,
    p_sort: params.sort ?? 'cost', p_order: params.order ?? 'desc',
  }).returns<PublishedLeaderboardRow[]>();
  if (error) throw new Error(`[leaderboard] published usage query failed: ${error.message}`);
  return data ?? [];
}
