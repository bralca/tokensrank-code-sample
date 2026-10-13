import { z } from "zod";

export const OGVariantSchema = z.enum(["a", "b"]);
export type OGVariant = z.infer<typeof OGVariantSchema>;

export const OGCardPropsSchema = z.object({
  handle: z.string(),
  displayName: z.string().nullable(),
  rank: z.number().positive(),
  totalTokens: z.bigint(),
  costUsd: z.number().nonnegative(),
  avatarUrl: z.string().url().nullable(),
  mode: z.enum(["script_verified", "self_reported"]),
  variant: OGVariantSchema,
}).strict();

export type OGCardProps = z.infer<typeof OGCardPropsSchema>;
