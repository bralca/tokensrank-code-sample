import type { z } from 'zod';

import type {
  AccessKeyIdSchema,
  AccessKeyListItemSchema,
  AccessKeyPrefixSchema,
  AccessKeyScopeSchema,
  AccessKeySchema,
  AccessKeySecretSchema,
  GenerateAccessKeyRequestSchema,
  GenerateAccessKeyResponseSchema,
  GenerateAccessKeySchema,
  ListAccessKeysResponseSchema,
  RevokeAccessKeyParamsSchema,
  RevokeAccessKeyResponseSchema,
} from '../schemas/access-keys.js';

export type AccessKeyScope = z.infer<typeof AccessKeyScopeSchema>;
export type AccessKeyId = z.infer<typeof AccessKeyIdSchema>;
export type AccessKeySecret = z.infer<typeof AccessKeySecretSchema>;
export type AccessKeyPrefix = z.infer<typeof AccessKeyPrefixSchema>;
export type GenerateAccessKey = z.infer<typeof GenerateAccessKeySchema>;
export type GenerateAccessKeyRequest = z.infer<typeof GenerateAccessKeyRequestSchema>;
export type GenerateAccessKeyResponse = z.infer<typeof GenerateAccessKeyResponseSchema>;
export type AccessKeyListItem = z.infer<typeof AccessKeyListItemSchema>;
export type AccessKey = z.infer<typeof AccessKeySchema>;
export type ListAccessKeysResponse = z.infer<typeof ListAccessKeysResponseSchema>;
export type RevokeAccessKeyParams = z.infer<typeof RevokeAccessKeyParamsSchema>;
export type RevokeAccessKeyResponse = z.infer<typeof RevokeAccessKeyResponseSchema>;
