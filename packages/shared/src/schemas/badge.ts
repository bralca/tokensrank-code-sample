import { z } from "zod";

// Badge tier
export const BadgeTierSchema = z.enum(["standard", "rare", "legendary"]);
export type BadgeTier = z.infer<typeof BadgeTierSchema>;

// Badge criteria (flexible JSON structure for various badge types)
// Badge criteria are versioned JSON rules; individual evaluators validate known keys.
export const BadgeCriteriaSchema = z.record(z.unknown());
export type BadgeCriteria = z.infer<typeof BadgeCriteriaSchema>;

// Badge response
export const BadgeSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon_slug: z.string(),
  criteria_json: BadgeCriteriaSchema,
  requires_verification: z.boolean(),
  tier: BadgeTierSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type Badge = z.infer<typeof BadgeSchema>;

// Profile badge
export const ProfileBadgeSchema = z.object({
  profile_id: z.string().uuid(),
  badge_slug: z.string(),
  awarded_at: z.string().datetime(),
  // Badge evidence is an immutable JSON snapshot whose shape varies by badge type.
  evidence: z.record(z.unknown()).nullable(),
  revoked_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime(),
}).strict();

export type ProfileBadge = z.infer<typeof ProfileBadgeSchema>;

// Full badge with award info
export const FullProfileBadgeSchema = BadgeSchema.extend({
  awarded_at: z.string().datetime(),
  // Badge evidence is an immutable JSON snapshot whose shape varies by badge type.
  evidence: z.record(z.unknown()).nullable(),
  revoked_at: z.string().datetime().nullable(),
}).strict();

export type FullProfileBadge = z.infer<typeof FullProfileBadgeSchema>;

// List badges response
export const ListBadgesResponseSchema = z.object({
  badges: z.array(BadgeSchema),
}).strict();

export type ListBadgesResponse = z.infer<typeof ListBadgesResponseSchema>;

// User's badges response
export const UserBadgesResponseSchema = z.object({
  badges: z.array(FullProfileBadgeSchema),
}).strict();

export type UserBadgesResponse = z.infer<typeof UserBadgesResponseSchema>;
