import { z } from 'zod';

import {
  AccessKeyIdSchema,
  AccessKeyPrefixSchema,
  AccessKeyScopeSchema,
  AccessKeySecretSchema,
} from './access-keys.js';

const SupabaseDateTimeSchema = z.string().datetime({ offset: true });

export const OnboardingStepSchema = z.enum([
  'not_started',
  'mode_chosen',
  'complete',
]);

export const PathChoiceSchema = z.enum([
  'script_verified',
  'self_reported',
]);

export const OnboardingModeRequestSchema = z.object({
  mode: PathChoiceSchema,
}).strict();

export const AccessKeyResponseSchema = z.object({
  id: AccessKeyIdSchema,
  scope: AccessKeyScopeSchema,
  prefix: AccessKeyPrefixSchema,
  plaintext: AccessKeySecretSchema,
  created_at: SupabaseDateTimeSchema,
}).strict().refine(
  (response) => response.plaintext.startsWith(`tr_${response.scope}_`),
  {
    message: 'Access key plaintext scope must match response scope',
    path: ['plaintext'],
  },
).refine(
  (response) => response.plaintext.startsWith(response.prefix),
  {
    message: 'Access key prefix must match plaintext prefix',
    path: ['prefix'],
  },
);

export const OnboardingStatusResponseSchema = z.object({
  data: z.object({
    step: OnboardingStepSchema,
    mode: PathChoiceSchema.nullable(),
    onboarded_at: SupabaseDateTimeSchema.nullable(),
    handle: z.string().nullable(),
  }).strict(),
}).strict();
