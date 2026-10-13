import { z } from 'zod';

export const ACCESS_KEY_RANDOM_PART_LENGTH = 32;
export const ACCESS_KEY_RANDOM_PART_PATTERN = '[A-Za-z0-9_-]{32}';

export const AccessKeyScopeSchema = z.enum(['script', 'self_reported']);

export const AccessKeyIdSchema = z.string().uuid();

export const AccessKeySecretSchema = z
  .string()
  .regex(
    /^tr_(script|self_reported)_[A-Za-z0-9_-]{32}$/,
    'Access key must match tr_<scope>_<32 base64url characters>',
  );

export const AccessKeyPrefixSchema = z
  .string()
  .regex(
    /^tr_[A-Za-z0-9_-]+$/,
    'Access key prefix must start with tr_ and contain only base64url-safe characters',
  )
  .max(31, 'Access key prefix must be shorter than a full access key');

export const GenerateAccessKeySchema = z.object({
  scope: AccessKeyScopeSchema,
}).strict();

export const GenerateAccessKeyRequestSchema = GenerateAccessKeySchema;

export const GenerateAccessKeyResponseSchema = z.object({
  id: AccessKeyIdSchema,
  scope: AccessKeyScopeSchema,
  prefix: AccessKeyPrefixSchema,
  plaintext: AccessKeySecretSchema,
  created_at: z.string().datetime(),
}).strict().refine(
  (response) => response.plaintext.startsWith(`tr_${response.scope}_`),
  {
    message: 'Access key plaintext scope must match response scope',
    path: ['plaintext'],
  },
).refine(
  (response) => response.plaintext.startsWith(response.prefix),
  {
    message: 'Access key prefix must match the plaintext prefix',
    path: ['prefix'],
  },
);

export const AccessKeyListItemSchema = z.object({
  keyId: AccessKeyIdSchema,
  keyPrefix: AccessKeyPrefixSchema,
  scope: AccessKeyScopeSchema,
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
}).strict();

export const AccessKeySchema = AccessKeyListItemSchema;

export const ListAccessKeysResponseSchema = z.array(AccessKeyListItemSchema);

export const RevokeAccessKeyParamsSchema = z.object({
  key_id: AccessKeyIdSchema,
}).strict();

export const RevokeAccessKeyResponseSchema = z.object({
  ok: z.literal(true),
}).strict();
