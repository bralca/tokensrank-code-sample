import autocannon, { type Result } from 'autocannon';

type CacheStatus = 'HIT' | 'MISS' | 'HIT-DEGRADED' | 'BYPASS' | 'UNKNOWN';

type LoadResult = {
  cacheStatuses: CacheStatus[];
  result: Result;
  timingsMs: number[];
};

type LeaderboardPerfOutput = {
  ok: boolean;
  target: string;
  config: {
    apiBaseUrl: string;
    durationSeconds: number;
    requestsPerSecond: number;
    connections: number;
    cachedP95BudgetMs: number;
    uncachedP95BudgetMs: number;
    cacheHitRateBudget: number;
  };
  cached: {
    p95Ms: number;
    p99Ms: number;
    hitRate: number;
    totalRequests: number;
    non2xx: number;
    errors: number;
    timeouts: number;
    cacheStatuses: Record<CacheStatus, number>;
  };
  uncached: {
    status: number;
    cacheStatus: string;
    latencyMs: number;
  };
  failures: string[];
};

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3001';
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_REQUESTS_PER_SECOND = 50;
const DEFAULT_CONNECTIONS = 10;
const DEFAULT_CACHED_P95_BUDGET_MS = 200;
const DEFAULT_UNCACHED_P95_BUDGET_MS = 1000;
const DEFAULT_CACHE_HIT_RATE_BUDGET = 0.95;
const LEADERBOARD_PATH = '/api/leaderboard?period=all&scope=all&limit=50&offset=0';

function readPositiveNumberEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseFloat(rawValue);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallback;
  }

  return parsedValue;
}

function readApiBaseUrl(): string {
  return (process.env.PERF_API_BASE_URL ?? process.env.API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
}

function buildLeaderboardUrl(apiBaseUrl: string): URL {
  return new URL(LEADERBOARD_PATH, apiBaseUrl);
}

function cacheStatusFromHeader(value: unknown): CacheStatus {
  const headerValue = Array.isArray(value) ? value[0] : value;

  if (typeof headerValue !== 'string') {
    return 'UNKNOWN';
  }

  if (
    headerValue === 'HIT'
    || headerValue === 'MISS'
    || headerValue === 'HIT-DEGRADED'
    || headerValue === 'BYPASS'
  ) {
    return headerValue;
  }

  return 'UNKNOWN';
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sortedValues = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((percentileValue / 100) * sortedValues.length) - 1,
  );

  return sortedValues[index] ?? 0;
}

function countCacheStatuses(statuses: CacheStatus[]): Record<CacheStatus, number> {
  return statuses.reduce<Record<CacheStatus, number>>((accumulator, status) => {
    accumulator[status] += 1;
    return accumulator;
  }, {
    HIT: 0,
    MISS: 0,
    'HIT-DEGRADED': 0,
    BYPASS: 0,
    UNKNOWN: 0,
  });
}

async function fetchRequired(url: URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new Error(`[perf:leaderboard] Request failed for ${url.toString()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function warmLeaderboardCache(targetUrl: URL): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    const response = await fetchRequired(targetUrl);

    if (!response.ok) {
      throw new Error(`[perf:leaderboard] Warm-up request failed with HTTP ${response.status}`);
    }
  }
}

async function purgeCache(apiBaseUrl: string): Promise<void> {
  const adminToken = process.env.ADMIN_PURGE_TOKEN;

  if (!adminToken) {
    throw new Error('[perf:leaderboard] ADMIN_PURGE_TOKEN is required to test uncached performance via cache purge');
  }

  const purgeUrl = new URL('/api/admin/cache/purge', apiBaseUrl);
  const origin = process.env.PERF_ALLOWED_ORIGIN ?? 'http://localhost:3000';
  const response = await fetchRequired(purgeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify({ all: true }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[perf:leaderboard] Cache purge failed with HTTP ${response.status}: ${body}`);
  }
}

async function measureUncachedRequest(apiBaseUrl: string, targetUrl: URL): Promise<LeaderboardPerfOutput['uncached']> {
  await purgeCache(apiBaseUrl);

  const startedAt = performance.now();
  const response = await fetchRequired(targetUrl);
  const latencyMs = performance.now() - startedAt;

  await response.arrayBuffer();

  return {
    status: response.status,
    cacheStatus: response.headers.get('x-tokensrank-cache') ?? 'UNKNOWN',
    latencyMs,
  };
}

async function runAutocannon(targetUrl: URL, config: {
  durationSeconds: number;
  requestsPerSecond: number;
  connections: number;
}): Promise<LoadResult> {
  const timingsMs: number[] = [];
  const cacheStatuses: CacheStatus[] = [];

  const result = await new Promise<Result>((resolve, reject) => {
    const instance = autocannon({
      url: targetUrl.origin,
      duration: config.durationSeconds,
      connections: config.connections,
      overallRate: config.requestsPerSecond,
      timeout: 10,
      requests: [{
        method: 'GET',
        path: `${targetUrl.pathname}${targetUrl.search}`,
        onResponse: (_status, _body, _context, headers) => {
          cacheStatuses.push(cacheStatusFromHeader(headers?.['x-tokensrank-cache']));
        },
      }],
    }, (error, autocannonResult) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(autocannonResult);
    });

    instance.on('response', (_client, _statusCode, _resBytes, responseTime) => {
      timingsMs.push(responseTime);
    });

    instance.on('reqError', (error) => {
      process.stderr.write(`[perf:leaderboard] request error: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });

  return {
    cacheStatuses,
    result,
    timingsMs,
  };
}

async function main(): Promise<void> {
  const apiBaseUrl = readApiBaseUrl();
  const targetUrl = buildLeaderboardUrl(apiBaseUrl);
  const durationSeconds = readPositiveNumberEnv('PERF_LEADERBOARD_DURATION_SECONDS', DEFAULT_DURATION_SECONDS);
  const requestsPerSecond = readPositiveNumberEnv('PERF_LEADERBOARD_RPS', DEFAULT_REQUESTS_PER_SECOND);
  const connections = readPositiveNumberEnv('PERF_LEADERBOARD_CONNECTIONS', DEFAULT_CONNECTIONS);
  const cachedP95BudgetMs = readPositiveNumberEnv('PERF_LEADERBOARD_CACHED_P95_MS', DEFAULT_CACHED_P95_BUDGET_MS);
  const uncachedP95BudgetMs = readPositiveNumberEnv('PERF_LEADERBOARD_UNCACHED_P95_MS', DEFAULT_UNCACHED_P95_BUDGET_MS);
  const cacheHitRateBudget = readPositiveNumberEnv('PERF_LEADERBOARD_HIT_RATE', DEFAULT_CACHE_HIT_RATE_BUDGET);

  await warmLeaderboardCache(targetUrl);

  const cachedLoad = await runAutocannon(targetUrl, {
    durationSeconds,
    requestsPerSecond,
    connections,
  });
  const uncached = await measureUncachedRequest(apiBaseUrl, targetUrl);
  const cacheStatuses = countCacheStatuses(cachedLoad.cacheStatuses);
  const totalCacheSamples = cachedLoad.cacheStatuses.length;
  const hitRate = totalCacheSamples === 0
    ? 0
    : cacheStatuses.HIT / totalCacheSamples;
  const cachedP95Ms = percentile(cachedLoad.timingsMs, 95);
  const cachedP99Ms = percentile(cachedLoad.timingsMs, 99);
  const failures: string[] = [];

  if (cachedP95Ms >= cachedP95BudgetMs) {
    failures.push(`cached p95 ${cachedP95Ms.toFixed(2)}ms exceeded ${cachedP95BudgetMs}ms`);
  }

  if (uncached.latencyMs >= uncachedP95BudgetMs) {
    failures.push(`uncached latency ${uncached.latencyMs.toFixed(2)}ms exceeded ${uncachedP95BudgetMs}ms`);
  }

  if (hitRate <= cacheHitRateBudget) {
    failures.push(`cache hit rate ${(hitRate * 100).toFixed(2)}% did not exceed ${(cacheHitRateBudget * 100).toFixed(2)}%`);
  }

  if (cachedLoad.result.non2xx > 0 || cachedLoad.result.errors > 0 || cachedLoad.result.timeouts > 0) {
    failures.push(`cached load had non2xx=${cachedLoad.result.non2xx}, errors=${cachedLoad.result.errors}, timeouts=${cachedLoad.result.timeouts}`);
  }

  if (uncached.status !== 200 || uncached.cacheStatus !== 'MISS') {
    failures.push(`uncached request returned status=${uncached.status}, cache=${uncached.cacheStatus}`);
  }

  const output: LeaderboardPerfOutput = {
    ok: failures.length === 0,
    target: targetUrl.toString(),
    config: {
      apiBaseUrl,
      durationSeconds,
      requestsPerSecond,
      connections,
      cachedP95BudgetMs,
      uncachedP95BudgetMs,
      cacheHitRateBudget,
    },
    cached: {
      p95Ms: cachedP95Ms,
      p99Ms: cachedP99Ms,
      hitRate,
      totalRequests: cachedLoad.timingsMs.length,
      non2xx: cachedLoad.result.non2xx,
      errors: cachedLoad.result.errors,
      timeouts: cachedLoad.result.timeouts,
      cacheStatuses,
    },
    uncached,
    failures,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (!output.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
