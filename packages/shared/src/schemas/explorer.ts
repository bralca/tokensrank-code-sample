import { z } from 'zod';
import { LeaderboardPeriodSchema } from './leaderboard.js';

export const UsageDimensionKindSchema = z.enum(['model', 'tool', 'provider']);
export type UsageDimensionKind = z.infer<typeof UsageDimensionKindSchema>;
export const UsageExplorerQuerySchema = z.object({
  kind: UsageDimensionKindSchema.default('model'),
  period: LeaderboardPeriodSchema.default('all'),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict();
const count = z.number().nonnegative();
const dimension = z.object({ kind: UsageDimensionKindSchema, key: z.string(), slug: z.string() });
export const UsageCatalogSchema = z.array(dimension.extend({
  tokens: count, api_value: count, builders: count, output_tokens: count.nullable(),
  api_value_partial:z.boolean().default(false),
  first_date: z.string(), last_date: z.string(), tools: z.array(z.string()), providers: z.array(z.string()),
}));
export type UsageCatalog = z.infer<typeof UsageCatalogSchema>;
export const UsageDimensionSchema = z.object({
  dimension: dimension.nullable(), tokens: count, api_value: count, builders: count, community_tokens: count, output_tokens: count.nullable(),
  first_date: z.string().nullable(), last_date: z.string().nullable(),
  rows: z.array(z.object({
    rank: count, handle: z.string(), display_name: z.string().nullable(), avatar_url: z.string().nullable(),
    tokens: count, api_value: count, models: count, tools: count, output_tokens: count.nullable(),
    api_value_partial:z.boolean().default(false),
  })),
  breakdown: z.array(dimension.extend({ tokens: count, builders: count })),
});
export type UsageDimension = z.infer<typeof UsageDimensionSchema>;
