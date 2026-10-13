import { z } from 'zod';

const exactKeysPurgeSchema = z
  .object({
    keys: z.array(z.string()),
  })
  .strict();

const prefixPurgeSchema = z
  .object({
    prefix: z.string(),
  })
  .strict();

const allPurgeSchema = z
  .object({
    all: z.literal(true),
  })
  .strict();

export const CachePurgeRequestSchema = z.union([
  exactKeysPurgeSchema,
  prefixPurgeSchema,
  allPurgeSchema,
]);

export const CachePurgeResponseSchema = z
  .object({
    data: z
      .object({
        purged_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type CachePurgeRequest = z.infer<typeof CachePurgeRequestSchema>;
export type CachePurgeResponse = z.infer<typeof CachePurgeResponseSchema>;
