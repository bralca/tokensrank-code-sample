import { z } from 'zod';

import { LeaderboardBadgesSchema } from './badges.js';

export const LeaderboardPeriodSchema = z.enum(['all', '30d', '7d', '24h']);

export type LeaderboardPeriod = z.infer<typeof LeaderboardPeriodSchema>;

export const LeaderboardScopeSchema = z.enum(['all', 'claude', 'codex', 'opencode']);

export type LeaderboardScope = z.infer<typeof LeaderboardScopeSchema>;

export const LeaderboardSortSchema = z.enum(['cost', 'tokens', 'sessions', 'active_days']);
export type LeaderboardSort = z.infer<typeof LeaderboardSortSchema>;
export const LeaderboardOrderSchema = z.enum(['desc', 'asc']);
export type LeaderboardOrder = z.infer<typeof LeaderboardOrderSchema>;

export const LeaderboardProfileModeSchema = z.enum(['script_verified', 'self_reported']);

export type LeaderboardProfileMode = z.infer<typeof LeaderboardProfileModeSchema>;

export const LEADERBOARD_LIMIT_MAX = 50;
export const LEADERBOARD_OFFSET_MAX = 10000;

const leaderboardIntegerQueryParamSchema = (
  fieldName: string,
  min: number,
  max: number,
) => z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return value;
  },
  z.coerce.number({
    invalid_type_error: `${fieldName} must be a number`,
  })
    .int(`${fieldName} must be an integer`)
    .min(min, `${fieldName} must be at least ${min}`)
    .max(max, `${fieldName} must be at most ${max}`),
);

/**
 * FR-49: GET /api/leaderboard query params.
 */
export const LeaderboardQuerySchema = z.object({
  period: LeaderboardPeriodSchema.default('all'),
  scope: LeaderboardScopeSchema.default('all'),
  sort: LeaderboardSortSchema.default('cost'),
  order: LeaderboardOrderSchema.default('desc'),
  limit: leaderboardIntegerQueryParamSchema('limit', 1, LEADERBOARD_LIMIT_MAX)
    .default(LEADERBOARD_LIMIT_MAX),
  offset: leaderboardIntegerQueryParamSchema('offset', 0, LEADERBOARD_OFFSET_MAX)
    .default(0),
}).strict();

export type LeaderboardQuery = z.infer<typeof LeaderboardQuerySchema>;

/**
 * FR-50: Ranked profile row returned by GET /api/leaderboard.
 */
export const LeaderboardRowSchema = z.object({
  rank: z.number().int().positive(),
  rank_delta: z.number().int(),
  handle: z.string().regex(/^[a-z0-9_-]{3,30}$/),
  display_name: z.string().min(1).max(100).nullable(),
  x_handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).nullable(),
  avatar_url: z.string().url().nullable(),
  mode: LeaderboardProfileModeSchema,
  tokens_total: z.number().int().nonnegative(),
  cost_usd_total: z.number().nonnegative(),
  sessions_count: z.number().int().nonnegative().nullable().optional(),
  active_days: z.number().int().nonnegative().nullable().optional(),
  api_value_partial: z.boolean().optional(),
  badges: LeaderboardBadgesSchema,
  top_model: z.string().nullable().optional(),
}).strict();

export type LeaderboardRow = z.infer<typeof LeaderboardRowSchema>;

/**
 * FR-50: GET /api/leaderboard response payload.
 */
export const LeaderboardResponseSchema = z.array(LeaderboardRowSchema);

export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;
