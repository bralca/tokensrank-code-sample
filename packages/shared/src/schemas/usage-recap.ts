import { z } from 'zod';
import { ProfileEvidenceSchema } from './evidence.js';

const PeriodSchema = z.object({
  start: z.string().date(), end: z.string().date(),
  tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative(),
  recorded_days: z.number().int().min(0).max(7),
  days: z.array(z.object({ date: z.string().date(), tokens: z.number().nonnegative() }).strict()).length(7),
}).strict();

/** Private dashboard recap. This is deliberately not part of the publish payload. */
export const UsageRecapSchema = z.object({
  current: PeriodSchema, previous: PeriodSchema,
  comparison: z.enum(['ready', 'no_data', 'short_history', 'legacy_dates', 'stale']),
  change_pct: z.number().finite().nullable(),
  read_at: z.string().datetime().nullable(),
  local_tokens_all_time: z.number().nonnegative(),
  models: z.array(z.object({
    model: z.string(), tokens: z.number().nonnegative(),
    share: z.number().min(0).max(1), previous_share: z.number().min(0).max(1).nullable(),
    change_points: z.number().min(-100).max(100).nullable(),
  }).strict()),
}).strict();
export type UsageRecap = z.infer<typeof UsageRecapSchema>;

export const PublicPresenceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('disconnected') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('unpublished'), profile_url: z.string().url() }).strict(),
  z.object({
    status: z.literal('available'), profile_url: z.string().url(), handle: z.string(),
    tokens: z.number().nonnegative(), published_at: z.string().datetime({ offset: true }).nullable(),
    rank: z.number().int().positive().nullable(), builders: z.number().int().nonnegative().nullable(),
    standings: ProfileEvidenceSchema.shape.standings,
  }).strict(),
]);
export type PublicPresence = z.infer<typeof PublicPresenceSchema>;
