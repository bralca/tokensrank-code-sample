import { LRUCache } from 'lru-cache';

type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

type CacheServiceOptions = {
  maxItems?: number;
  maxSizeBytes?: number;
  ttlSeconds?: number;
};

type CacheContext = {
  onStatus?: (status: CacheStatus) => void;
};

type CacheEntry<T> = {
  value: T;
  createdAt: number;
};

const DEFAULT_CACHE_TTL_SECONDS = 3600;
const DEFAULT_MAX_CACHE_ITEMS = 5000;
const DEFAULT_MAX_CACHE_SIZE_BYTES = 52_428_800;
const SERIALIZATION_FALLBACK_BYTES = 1024;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function calculateEntrySize(entry: CacheEntry<unknown>): number {
  try {
    const serializedValue = JSON.stringify(entry.value);

    if (!serializedValue) {
      return SERIALIZATION_FALLBACK_BYTES;
    }

    return Math.max(1, Buffer.byteLength(serializedValue, 'utf8'));
  } catch {
    return SERIALIZATION_FALLBACK_BYTES;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    cache: CacheService;
  }
}

export class CacheService {
  private readonly cache: LRUCache<string, CacheEntry<unknown>>;

  private readonly inFlightLoads = new Map<string, Promise<unknown>>();

  private readonly defaultTtlSeconds: number;

  constructor(options: CacheServiceOptions = {}) {
    this.defaultTtlSeconds = options.ttlSeconds
      ?? readPositiveIntegerEnv('CACHE_TTL_SECONDS', DEFAULT_CACHE_TTL_SECONDS);

    this.cache = new LRUCache<string, CacheEntry<unknown>>({
      max: options.maxItems ?? readPositiveIntegerEnv('MAX_CACHE_ITEMS', DEFAULT_MAX_CACHE_ITEMS),
      maxSize: options.maxSizeBytes
        ?? readPositiveIntegerEnv('MAX_CACHE_SIZE_BYTES', DEFAULT_MAX_CACHE_SIZE_BYTES),
      sizeCalculation: calculateEntrySize,
      ttl: this.defaultTtlSeconds * 1000,
      allowStale: false,
    });
  }

  /**
   * Returns a cached value or loads and stores it once for concurrent callers.
   *
   * @param key Unique cache key.
   * @param ttlSeconds Entry TTL in seconds.
   * @param loader Async loader called only on cache miss.
   * @param context Optional status hook for response headers.
   * @returns Cached or freshly loaded value.
   */
  async withCache<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
    context: CacheContext = {},
  ): Promise<T> {
    const cachedEntry = this.cache.get(key);

    if (cachedEntry !== undefined) {
      context.onStatus?.('HIT');

      return cachedEntry.value as T;
    }

    context.onStatus?.('MISS');

    const inFlightLoad = this.inFlightLoads.get(key);

    if (inFlightLoad) {
      return await inFlightLoad as T;
    }

    const loadPromise = (async () => {
      try {
        const value = await loader();
        this.cache.set(
          key,
          {
            value,
            createdAt: Date.now(),
          },
          {
            ttl: this.resolveTtlMs(ttlSeconds),
          },
        );

        return value;
      } catch (error) {
        context.onStatus?.('BYPASS');
        throw error;
      } finally {
        this.inFlightLoads.delete(key);
      }
    })();

    this.inFlightLoads.set(key, loadPromise);

    return await loadPromise as T;
  }

  /**
   * Removes one exact key from the cache.
   *
   * @param key Exact cache key to purge.
   * @returns True when an entry was removed.
   */
  purgeKey(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Removes all keys that begin with the provided prefix.
   *
   * @param prefix Cache key prefix to purge.
   * @returns Number of purged entries.
   */
  purgeByPrefix(prefix: string): number {
    let purgedCount = 0;

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        purgedCount += 1;
      }
    }

    return purgedCount;
  }

  /**
   * Removes exact cache keys and wildcard patterns from the cache.
   *
   * Wildcards use `*` as a segment matcher, for example
   * `profile:v*:alex:*` matches all cached profile windows for alex.
   *
   * @param keys Exact keys or wildcard patterns to purge.
   * @returns Number of entries removed.
   */
  purgeKeys(keys: string[]): number {
    let purgedCount = 0;

    for (const key of keys) {
      if (!key.includes('*')) {
        if (this.cache.delete(key)) {
          purgedCount += 1;
        }

        continue;
      }

      const pattern = new RegExp(`^${key
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`);

      for (const existingKey of this.cache.keys()) {
        if (pattern.test(existingKey)) {
          this.cache.delete(existingKey);
          purgedCount += 1;
        }
      }
    }

    return purgedCount;
  }

  /**
   * Clears every cached value and any pending single-flight loaders.
   *
   * @returns Number of entries removed.
   */
  purgeAll(): number {
    const purgedCount = this.cache.size;
    this.cache.clear();
    this.inFlightLoads.clear();

    return purgedCount;
  }

  private resolveTtlMs(ttlSeconds: number): number {
    const effectiveTtlSeconds = ttlSeconds > 0 ? ttlSeconds : this.defaultTtlSeconds;

    return effectiveTtlSeconds * 1000;
  }
}

export const cacheService = new CacheService();
