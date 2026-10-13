import { createHash } from 'node:crypto';

import { adminClient } from '../clients/supabase';

/**
 * models.dev pricing sync.
 *
 * Fetches the public models.dev catalog once, keeps only the canonical
 * providers we ingest from (Anthropic, OpenAI), and upserts per-model rates
 * into `model_pricing`. Rows whose content hash is unchanged are skipped, so a
 * daily run only writes what actually changed. Rates are stored verbatim in
 * models.dev units (USD per 1,000,000 tokens); the cost helper divides by 1e6.
 */

const MODELS_DEV_API = 'https://models.dev/api.json';

// Providers whose ids match the model strings we ingest (source 'claude'→anthropic,
// 'codex'→openai). Add more here as we ingest other providers.
export const CANONICAL_PROVIDERS = ['anthropic', 'openai'] as const;

export type FetchImpl = typeof fetch;
type SupabaseLike = Pick<typeof adminClient, 'from'>;

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

export type ModelPricingRow = {
  provider: string;
  model_id: string;
  name: string | null;
  family: string | null;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  source_last_updated: string | null;
  content_hash: string;
};

export type SyncResult = {
  providers: number;
  modelsSeen: number;
  upserted: number;
  skipped: number;
};

function num(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Stable hash of the pricing-relevant fields so unchanged rows are skipped. */
function hashRow(row: Omit<ModelPricingRow, 'content_hash'>): string {
  const payload = JSON.stringify([
    row.name,
    row.family,
    row.input_per_mtok,
    row.output_per_mtok,
    row.cache_read_per_mtok,
    row.cache_write_per_mtok,
    row.source_last_updated,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

/** Map one models.dev model into a model_pricing row (or null if it has no id). */
export function toPricingRow(provider: string, model: ModelsDevModel): ModelPricingRow | null {
  const modelId = (model.id ?? '').trim();
  if (!modelId) return null;
  const cost = model.cost ?? {};
  const base: Omit<ModelPricingRow, 'content_hash'> = {
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

/** Extract canonical-provider pricing rows from a parsed models.dev catalog. */
export function extractPricingRows(catalog: Record<string, ModelsDevProvider>): ModelPricingRow[] {
  const rows: ModelPricingRow[] = [];
  for (const provider of CANONICAL_PROVIDERS) {
    const models = catalog[provider]?.models ?? {};
    for (const model of Object.values(models)) {
      const row = toPricingRow(provider, model);
      if (row) rows.push(row);
    }
  }
  return rows;
}

export async function syncModelPricing(options: {
  supabaseClient?: SupabaseLike;
  fetchImpl?: FetchImpl;
} = {}): Promise<SyncResult> {
  const client = options.supabaseClient ?? adminClient;
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(MODELS_DEV_API, { headers: { 'User-Agent': 'tokensrank-pricing-sync' } });
  if (!response.ok) {
    throw new Error(`[models-dev-sync] ${MODELS_DEV_API} -> ${response.status} ${response.statusText}`);
  }
  const catalog = (await response.json()) as Record<string, ModelsDevProvider>;
  const rows = extractPricingRows(catalog);

  // Load existing hashes so we only upsert changed rows.
  const { data: existing, error: loadError } = await client
    .from('model_pricing')
    .select('provider,model_id,content_hash')
    .returns<Array<{ provider: string; model_id: string; content_hash: string }>>();
  if (loadError) throw new Error(`[models-dev-sync] load existing failed: ${loadError.message}`);
  const existingHash = new Map<string, string>();
  for (const r of existing ?? []) existingHash.set(`${r.provider}:${r.model_id}`, r.content_hash);

  const changed = rows.filter((row) => existingHash.get(`${row.provider}:${row.model_id}`) !== row.content_hash);

  if (changed.length > 0) {
    const stamped = changed.map((row) => ({ ...row, fetched_at: new Date().toISOString() }));
    const { error } = await client.from('model_pricing').upsert(stamped, { onConflict: 'provider,model_id' });
    if (error) throw new Error(`[models-dev-sync] upsert failed: ${error.message}`);
  }

  return {
    providers: CANONICAL_PROVIDERS.length,
    modelsSeen: rows.length,
    upserted: changed.length,
    skipped: rows.length - changed.length,
  };
}
