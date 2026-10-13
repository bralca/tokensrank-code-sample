const PER_MTOK = 1_000_000;

export type ModelRate = {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
};

export type PricingMap = Map<string, ModelRate>;

export type SessionTokens = {
  source: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
};

export type CostResult = {
  costUsd: number;
  matched: boolean;
};

export function pricingKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

export function providerForSource(source: string, model: string): 'anthropic' | 'openai' | null {
  if (source === 'claude') return 'anthropic';
  if (source === 'codex') return 'openai';

  const normalizedModel = (model || '').toLowerCase();
  if (normalizedModel.startsWith('claude')) return 'anthropic';
  if (normalizedModel.startsWith('gpt') || normalizedModel.includes('codex') || /^o[0-9]/u.test(normalizedModel)) {
    return 'openai';
  }

  return null;
}

export function lookupRate(pricing: PricingMap, provider: string, model: string): ModelRate | null {
  const candidates = [
    model,
    model.replace(/-latest$/iu, ''),
    model.split('@')[0] ?? model,
    model.replace(/-\d{8}$/iu, ''),
  ];

  for (const candidate of candidates) {
    const rate = pricing.get(pricingKey(provider, candidate));
    if (rate) return rate;
  }

  return null;
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function costForSession(session: SessionTokens, pricing: PricingMap): CostResult {
  const provider = providerForSource(session.source, session.model);
  const rate = provider ? lookupRate(pricing, provider, session.model) : null;

  if (!rate || rate.input == null) {
    return { costUsd: 0, matched: false };
  }

  const inputRate = finiteOrZero(rate.input) / PER_MTOK;
  const outputRate = finiteOrZero(rate.output) / PER_MTOK;
  const cacheReadRate = (rate.cache_read ?? rate.input ?? 0) / PER_MTOK;
  const cacheWriteRate = (rate.cache_write ?? rate.input ?? 0) / PER_MTOK;

  if (provider === 'anthropic') {
    return {
      costUsd: session.input_tokens * inputRate
        + session.cache_read_tokens * cacheReadRate
        + session.cache_create_tokens * cacheWriteRate
        + session.output_tokens * outputRate,
      matched: true,
    };
  }

  const uncachedInput = Math.max(0, session.input_tokens - session.cached_tokens);
  return {
    costUsd: uncachedInput * inputRate
      + session.cached_tokens * cacheReadRate
      + session.output_tokens * outputRate
      + session.cache_read_tokens * cacheReadRate
      + session.cache_create_tokens * cacheWriteRate,
    matched: true,
  };
}
