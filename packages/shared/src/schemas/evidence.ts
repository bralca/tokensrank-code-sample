import { z } from 'zod';

export const UsageEvidenceSchema = z.object({
  version: z.literal(1),
  sources: z.array(z.object({
    source: z.enum(['claude','codex','opencode']),
    daily_basis: z.enum(['event_dates','session_dates']),
    read_at: z.string().datetime().nullable(),
    unpriced_models: z.array(z.string().min(1).max(256)).max(2000).default([]),
  }).strict()).max(3),
  attribution: z.object({
    sessions: z.number().int().nonnegative(),
    linked_sessions: z.number().int().nonnegative(),
  }).strict().refine(v=>v.linked_sessions<=v.sessions, 'Linked sessions cannot exceed observed sessions').nullable(),
}).strict().refine(v=>new Set(v.sources.map(s=>s.source)).size===v.sources.length,'Each source is included once');
export type UsageEvidence = z.infer<typeof UsageEvidenceSchema>;

export const ProfileEvidenceSchema = z.object({
  github_login: z.string().nullable(),
  published_at: z.string().datetime({offset:true}).nullable(),
  output_tokens: z.number().int().nonnegative().nullable().default(null),
  usage: UsageEvidenceSchema.nullable(),
  contribution: z.object({
    repositories: z.number().int().nonnegative(),
    commits: z.number().int().nonnegative(),
    checked_at: z.string().datetime({offset:true}).nullable(),
  }).strict().nullable(),
  standings: z.array(z.object({
    kind: z.enum(['model','tool']), key:z.string(), slug:z.string(),
    rank:z.number().int().positive(), builders:z.number().int().positive(),
  }).strict()).max(6),
}).strict();
