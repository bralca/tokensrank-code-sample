import { z } from 'zod';

export const BadgeSlugSchema = z.string().regex(/^[a-z0-9_]+$/);

export type BadgeSlug = z.infer<typeof BadgeSlugSchema>;

export const BadgeColorHexSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export type BadgeColorHex = z.infer<typeof BadgeColorHexSchema>;

/**
 * FR-57: Badge criteria are stored as flexible JSONB because each badge
 * has a different evaluator-specific shape.
 */
// Badge criteria are versioned JSON rules; individual evaluators validate known keys.
export const BadgeCriteriaSchema = z.record(z.unknown());

export type BadgeCriteria = z.infer<typeof BadgeCriteriaSchema>;

/**
 * FR-53, FR-57: Catalog row for a design-canon badge definition.
 */
export const BadgeDefinitionSchema = z.object({
  badge_id: z.string().uuid(),
  slug: BadgeSlugSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  icon_url: z.string().url().nullable(),
  color_hex: BadgeColorHexSchema,
  requires_verification: z.boolean(),
  criteria_json: BadgeCriteriaSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type BadgeDefinition = z.infer<typeof BadgeDefinitionSchema>;

export const BadgeDefinitionsArraySchema = z.array(BadgeDefinitionSchema);

export type BadgeDefinitionsArray = z.infer<typeof BadgeDefinitionsArraySchema>;

/**
 * FR-56: Badge award evidence snapshot stored in profile_badges.evidence_json.
 */
// Badge evidence is an immutable JSON snapshot whose shape varies by badge type.
export const BadgeEvidenceSchema = z.record(z.unknown());

export type BadgeEvidence = z.infer<typeof BadgeEvidenceSchema>;

/**
 * FR-53, FR-56: Profile badge award row returned by profile endpoints.
 */
export const ProfileBadgeSchema = z.lazy(() => z.object({
  profile_id: z.string().uuid(),
  badge_id: z.string().uuid(),
  awarded_at: z.string().datetime(),
  evidence_json: BadgeEvidenceSchema,
  badge: BadgeDefinitionSchema,
}).strict());

export type ProfileBadge = z.infer<typeof ProfileBadgeSchema>;

export const ProfileBadgesArraySchema = z.array(ProfileBadgeSchema);

export type ProfileBadgesArray = z.infer<typeof ProfileBadgesArraySchema>;

/**
 * FR-50: Lean badge shape embedded in leaderboard rows.
 */
export const BadgeResponseSchema = z.object({
  slug: BadgeSlugSchema,
  name: z.string().min(1),
  icon: z.string().min(1),
  color: BadgeColorHexSchema,
}).strict();

export type BadgeResponse = z.infer<typeof BadgeResponseSchema>;

export const LeaderboardBadgesSchema = z.array(BadgeResponseSchema).max(5);

export type LeaderboardBadges = z.infer<typeof LeaderboardBadgesSchema>;
