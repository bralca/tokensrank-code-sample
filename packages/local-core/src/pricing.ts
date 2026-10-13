import { createHash } from 'node:crypto';

import type { LocalPricingStatus } from '@tokensrank/shared';

import type { LocalDatabase } from './db.js';
import { nowIso, readSyncState, writeSyncState } from './db.js';
import { pricingKey, type PricingMap } from './cost.js';
import type { PricingRow } from './types.js';
import { BUNDLED_PRICING_SNAPSHOT } from './pricing-snapshot.js';

const MODELS_DEV_API = 'https://models.dev/api.json';
const CANONICAL_PROVIDERS = ['anthropic', 'openai'] as const;

type ModelsDevCost = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
};

type ModelsDevModel = {
  id?: string;
  name?: string;
  family?: string;
  last_updated?: string;
  cost?: ModelsDevCost;
};

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>;
};

function num(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hashRow(row: Omit<PricingRow, 'content_hash' | 'fetched_at'>): string {
  return createHash('sha256').update(JSON.stringify([
    row.name,
    row.family,
    row.input_per_mtok,
    row.output_per_mtok,
    row.cache_read_per_mtok,
    row.cache_write_per_mtok,
    row.source_last_updated,
  ])).digest('hex');
}

function toPricingRow(provider: string, model: ModelsDevModel): PricingRow | null {
  const modelId = (model.id ?? '').trim();
  if (!modelId) return null;
  const cost = model.cost ?? {};
  const base: Omit<PricingRow, 'content_hash' | 'fetched_at'> = {
    provider,
    model_id: modelId,
    name: model.name ?? null,
    family: model.family ?? null,
    input_per_mtok: num(cost.input),
    output_per_mtok: num(cost.output),
    cache_read_per_mtok: num(cost.cache_read),
    cache_write_per_mtok: num(cost.cache_write),
    source_last_updated: model.last_updated ?? null,
  };
  return { ...base, content_hash: hashRow(base) };
}

export function extractPricingRows(catalog: Record<string, ModelsDevProvider>): PricingRow[] {
  const rows: PricingRow[] = [];

  for (const provider of CANONICAL_PROVIDERS) {
    const models = catalog[provider]?.models ?? {};
    for (const model of Object.values(models)) {
      const row = toPricingRow(provider, model);
      if (row) rows.push(row);
    }
  }

  return rows;
}

export function upsertPricingRows(db: LocalDatabase, rows: PricingRow[], fetchedAt = nowIso()): number {
  if (rows.length === 0) return 0;

  const stmt = db.prepare(`
    INSERT INTO model_pricing (
      provider, model_id, name, family, input_per_mtok, output_per_mtok,
      cache_read_per_mtok, cache_write_per_mtok, source_last_updated,
      content_hash, fetched_at
    )
    VALUES (
      @provider, @model_id, @name, @family, @input_per_mtok, @output_per_mtok,
      @cache_read_per_mtok, @cache_write_per_mtok, @source_last_updated,
      @content_hash, @fetched_at
    )
    ON CONFLICT(provider, model_id) DO UPDATE SET
      name = excluded.name,
      family = excluded.family,
      input_per_mtok = excluded.input_per_mtok,
      output_per_mtok = excluded.output_per_mtok,
      cache_read_per_mtok = excluded.cache_read_per_mtok,
      cache_write_per_mtok = excluded.cache_write_per_mtok,
      source_last_updated = excluded.source_last_updated,
      content_hash = excluded.content_hash,
      fetched_at = excluded.fetched_at
  `);

  const run = db.transaction((nextRows: PricingRow[]) => {
    for (const row of nextRows) {
      stmt.run({ ...row, fetched_at: row.fetched_at ?? fetchedAt });
    }
  });

  run(rows);
  return rows.length;
}

function existingPricingHashes(db: LocalDatabase): Map<string, string> {
  const rows = db.prepare(`
    SELECT provider, model_id, content_hash
    FROM model_pricing
  `).all() as Array<{ provider: string; model_id: string; content_hash: string }>;

  return new Map(rows.map((row) => [`${row.provider}:${row.model_id}`, row.content_hash]));
}

export function seedBundledPricing(db: LocalDatabase): number {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM model_pricing').get() as { count: number };
  if (existing.count > 0) return 0;
  const count = upsertPricingRows(db, BUNDLED_PRICING_SNAPSHOT, nowIso());
  writeSyncState(db, 'pricing_status', {
    row_count: count,
    fetched_at: null,
    source: 'bundled_snapshot',
    last_error: null,
  });
  return count;
}

function currentPricingStatus(db: LocalDatabase): LocalPricingStatus {
  const rowCount = db.prepare('SELECT COUNT(*) AS count FROM model_pricing').get() as { count: number };
  return readSyncState<LocalPricingStatus>(db, 'pricing_status', {
    row_count: rowCount.count,
    fetched_at: null,
    source: rowCount.count > 0 ? 'bundled_snapshot' : 'empty',
    last_error: null,
  });
}

export async function syncModelPricingLocal(db: LocalDatabase, fetchImpl: typeof fetch = fetch): Promise<{
  row_count: number;
  fetched_at: string;
  source: 'models.dev';
  last_error: null;
}> {
  const response = await fetchImpl(MODELS_DEV_API, {
    headers: { 'User-Agent': 'tokensrank-local-pricing-sync' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`[local-pricing] ${MODELS_DEV_API} -> ${response.status} ${response.statusText}`);
  }

  const catalog = await response.json() as Record<string, ModelsDevProvider>;
  const rows = extractPricingRows(catalog);
  const fetchedAt = nowIso();
  const existingHashes = existingPricingHashes(db);
  const changedRows = rows.filter((row) => existingHashes.get(`${row.provider}:${row.model_id}`) !== row.content_hash);
  upsertPricingRows(db, changedRows, fetchedAt);

  const status = {
    row_count: rows.length,
    fetched_at: fetchedAt,
    source: 'models.dev' as const,
    last_error: null,
  };
  writeSyncState(db, 'pricing_status', status);
  return status;
}

export async function syncModelPricingLocalSafe(
  db: LocalDatabase,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalPricingStatus> {
  try {
    return await syncModelPricingLocal(db, fetchImpl);
  } catch (error) {
    const current = currentPricingStatus(db);
    const status: LocalPricingStatus = {
      ...current,
      last_error: error instanceof Error ? error.message : String(error),
    };
    writeSyncState(db, 'pricing_status', status);
    return status;
  }
}

export function loadPricingMap(db: LocalDatabase): PricingMap {
  const rows = db.prepare(`
    SELECT provider, model_id, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok
    FROM model_pricing
  `).all() as Array<{
    provider: string;
    model_id: string;
    input_per_mtok: number | null;
    output_per_mtok: number | null;
    cache_read_per_mtok: number | null;
    cache_write_per_mtok: number | null;
  }>;

  const map: PricingMap = new Map();
  for (const row of rows) {
    map.set(pricingKey(row.provider, row.model_id), {
      input: row.input_per_mtok,
      output: row.output_per_mtok,
      cache_read: row.cache_read_per_mtok,
      cache_write: row.cache_write_per_mtok,
    });
  }

  return map;
}

export function pricingSnapshot(db: LocalDatabase): Array<{ provider: string; model_id: string; content_hash: string }> {
  return db.prepare(`
    SELECT provider, model_id, content_hash
    FROM model_pricing
    ORDER BY provider, model_id
  `).all() as Array<{ provider: string; model_id: string; content_hash: string }>;
}
