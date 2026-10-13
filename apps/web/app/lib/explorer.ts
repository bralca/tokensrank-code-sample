import { cache } from 'react';
import { createHash } from 'node:crypto';
import { UsageCatalogSchema, UsageDimensionSchema, UsageExplorerQuerySchema, type UsageDimensionKind } from '@tokensrank/shared';
import { apiFetch, ApiFetchError } from '../../lib/api';

export const directoryPaths = { model: '/models', tool: '/tools', provider: '/providers' } as const;
export const dimensionLabels = { model: 'Models', tool: 'Tools', provider: 'Providers' } as const;
export function dimensionLabel(kind: UsageDimensionKind, key: string) {
  if (kind === 'tool') return ({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' } as Record<string,string>)[key] ?? key;
  if (kind === 'provider') return ({ openai: 'OpenAI', anthropic: 'Anthropic', unknown: 'Unspecified provider' } as Record<string,string>)[key] ?? key;
  return key.replace(/^(anthropic|openai)\//, '').replace(/(\d)-(\d)(?=-|$)/g, '$1.$2').replace(/-/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bGpt\b/g, 'GPT');
}
export function modelSlug(key: string) {
  const readable = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  return `${readable}-${createHash('md5').update(key).digest('hex').slice(0, 8)}`;
}
export function dimensionPath(kind: UsageDimensionKind, slug: string) { return `${directoryPaths[kind]}/${slug}`; }
export const loadUsageCatalog = cache(async (kind: UsageDimensionKind, period = 'all') => {
  const result = await apiFetch<{ data: unknown }>(`/api/explore?kind=${kind}&period=${period}`, { cache: 'no-store' });
  return UsageCatalogSchema.parse(result.data);
});
export const loadUsageDimension = cache(async (kind: UsageDimensionKind, slug: string, period = 'all', offset = 0) => {
  try {
    const result = await apiFetch<{ data: unknown }>(`/api/explore/${encodeURIComponent(slug)}?kind=${kind}&period=${period}&offset=${offset}`, { cache: 'no-store' });
    return UsageDimensionSchema.parse(result.data);
  } catch (error) {
    if (error instanceof ApiFetchError && error.status === 404) return null;
    throw error;
  }
});
export function explorerFilters(search: Record<string, string | string[] | undefined>) {
  return UsageExplorerQuerySchema.parse({
    period: typeof search.period === 'string' && ['all','30d','7d','24h'].includes(search.period) ? search.period : 'all',
    offset: typeof search.offset === 'string' && /^\d+$/.test(search.offset) ? Math.min(10000, Number(search.offset)) : 0,
  });
}
export const explorerPeriods = [['all', 'All time'], ['30d', '30 days'], ['7d', '7 days'], ['24h', 'Today (UTC)']] as const;
export function jsonLd(value: unknown) { return JSON.stringify(value).replace(/</g, '\\u003c'); }
