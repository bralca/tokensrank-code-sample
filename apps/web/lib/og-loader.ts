import { z } from 'zod';

import { apiFetch, ApiFetchError } from './api';

const TOKEN_FORMATS = [
  { value: 1_000_000_000, suffix: 'B' },
  { value: 1_000_000, suffix: 'M' },
  { value: 1_000, suffix: 'K' },
] as const;

const OGProfileSchema = z.object({
  handle: z.string().min(1),
  display_name: z.string().min(1),
  total_tokens: z.number().int().nonnegative(),
  cost_usd_total: z.number().nonnegative().nullable().optional(),
  mode: z.enum(['script_verified', 'self_reported']),
  avatar_url: z.string().url(),
  rank: z.number().int().positive().optional(),
}).strict();

const NestedProfileResponseSchema = z.object({
  identity: z.object({
    handle: z.string().min(1),
    display_name: z.string().nullable(),
    avatar_url: z.string().url().nullable(),
    mode: z.enum(['script_verified', 'self_reported']).nullable(),
  }).passthrough(),
  headline: z.object({
    rank: z.number().int().positive().nullable(),
    tokens_total: z.number().int().nonnegative(),
    cost_usd_total: z.number().nonnegative().nullable().optional(),
  }).passthrough(),
}).passthrough();

export type OGProfileData = z.infer<typeof OGProfileSchema>;

export class OGProfileNotFoundError extends Error {
  public constructor(handle: string) {
    super(`OG profile data not found for handle "${handle}"`);
    this.name = 'OGProfileNotFoundError';
  }
}

export function formatTokens(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));

  for (const format of TOKEN_FORMATS) {
    if (normalized >= format.value) {
      const amount = normalized / format.value;
      const rounded = Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1);
      return `${rounded}${format.suffix}`;
    }
  }

  return String(normalized);
}

export function formatCost(value: number | null | undefined): string {
  if(value == null) return 'API value unavailable';
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Math.max(0,value));
}

function normalizeProfileResponse(raw: unknown): OGProfileData {
  const flat = OGProfileSchema.safeParse(raw);

  if (flat.success) {
    return flat.data;
  }

  const nested = NestedProfileResponseSchema.safeParse(raw);

  if (nested.success) {
    return OGProfileSchema.parse({
      handle: nested.data.identity.handle,
      display_name: nested.data.identity.display_name ?? nested.data.identity.handle,
      total_tokens: nested.data.headline.tokens_total,
      cost_usd_total: nested.data.headline.cost_usd_total ?? null,
      mode: nested.data.identity.mode ?? 'self_reported',
      avatar_url: nested.data.identity.avatar_url ?? `https://api.dicebear.com/9.x/initials/png?seed=${encodeURIComponent(nested.data.identity.handle)}`,
      rank: nested.data.headline.rank ?? undefined,
    });
  }

  throw new Error(`[og-loader] Profile response is missing required OG fields: ${flat.error.message}`);
}

export async function loadOGProfileData(handle: string) {
  try {
    const profileResponse = await apiFetch<unknown>(
      `/api/profile/${encodeURIComponent(handle)}?window=all`,
      {
        cache: 'no-store',
      },
    );

    const profile = normalizeProfileResponse(profileResponse);

    return {
      profile,
      formatTokens,
      formatCost,
    };
  } catch (error) {
    if (error instanceof ApiFetchError && error.status === 404) {
      throw new OGProfileNotFoundError(handle);
    }

    throw error;
  }
}
