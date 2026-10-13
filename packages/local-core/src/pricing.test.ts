import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openLocalStore, readSyncState } from './db.js';
import { seedBundledPricing, syncModelPricingLocal, syncModelPricingLocalSafe } from './pricing.js';

const modelsDevCatalog = {
  openai: {
    models: {
      'gpt-test': {
        id: 'gpt-test',
        name: 'GPT Test',
        family: 'gpt',
        last_updated: '2026-06-04',
        cost: {
          input: 1,
          output: 2,
          cache_read: 0.1,
          cache_write: 1.25,
        },
      },
    },
  },
  anthropic: {
    models: {},
  },
};

function pricingCatalogResponse(): Response {
  return new Response(JSON.stringify(modelsDevCatalog), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('local model pricing', () => {
  it('seeds bundled pricing for first-run offline use', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-pricing-'));
    const store = openLocalStore({ dataDir });

    try {
      const seeded = seedBundledPricing(store.db);
      const row = store.db.prepare('SELECT COUNT(*) AS count FROM model_pricing').get() as { count: number };
      const status = readSyncState(store.db, 'pricing_status', null) as {
        row_count: number;
        fetched_at: string | null;
        source: string;
        last_error: string | null;
      } | null;

      expect(seeded).toBeGreaterThan(0);
      expect(row.count).toBe(seeded);
      expect(status).toEqual({
        row_count: seeded,
        fetched_at: null,
        source: 'bundled_snapshot',
        last_error: null,
      });
    } finally {
      store.close();
    }
  });

  it('keeps existing rows and stores a warning when models.dev refresh fails', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-pricing-'));
    const store = openLocalStore({ dataDir });

    try {
      const seeded = seedBundledPricing(store.db);
      const status = await syncModelPricingLocalSafe(store.db, async () => (
        new Response('offline', { status: 503, statusText: 'Service Unavailable' })
      ));
      const row = store.db.prepare('SELECT COUNT(*) AS count FROM model_pricing').get() as { count: number };

      expect(row.count).toBe(seeded);
      expect(status).toMatchObject({
        row_count: seeded,
        source: 'bundled_snapshot',
        fetched_at: null,
      });
      expect(status.last_error).toContain('503 Service Unavailable');
    } finally {
      store.close();
    }
  });

  it('syncs models.dev rows and clears previous pricing warnings', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-pricing-'));
    const store = openLocalStore({ dataDir });

    try {
      await syncModelPricingLocalSafe(store.db, async () => (
        new Response('offline', { status: 503, statusText: 'Service Unavailable' })
      ));

      const status = await syncModelPricingLocal(store.db, async () => pricingCatalogResponse());

      const stored = readSyncState(store.db, 'pricing_status', null) as typeof status | null;
      const row = store.db.prepare(`
        SELECT provider, model_id, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok
        FROM model_pricing
        WHERE provider = 'openai' AND model_id = 'gpt-test'
      `).get();

      expect(row).toMatchObject({
        provider: 'openai',
        model_id: 'gpt-test',
        input_per_mtok: 1,
        output_per_mtok: 2,
        cache_read_per_mtok: 0.1,
        cache_write_per_mtok: 1.25,
      });
      expect(stored).toMatchObject({
        row_count: 1,
        source: 'models.dev',
        last_error: null,
      });
    } finally {
      store.close();
    }
  });

  it('skips unchanged models.dev rows by content hash', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-pricing-'));
    const store = openLocalStore({ dataDir });

    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-04T10:00:00.000Z'));
      await syncModelPricingLocal(store.db, async () => pricingCatalogResponse());

      const first = store.db.prepare(`
        SELECT fetched_at
        FROM model_pricing
        WHERE provider = 'openai' AND model_id = 'gpt-test'
      `).get() as { fetched_at: string };

      vi.setSystemTime(new Date('2026-06-05T10:00:00.000Z'));
      await syncModelPricingLocal(store.db, async () => pricingCatalogResponse());

      const second = store.db.prepare(`
        SELECT fetched_at
        FROM model_pricing
        WHERE provider = 'openai' AND model_id = 'gpt-test'
      `).get() as { fetched_at: string };

      expect(second.fetched_at).toBe(first.fetched_at);
    } finally {
      store.close();
    }
  });
});
