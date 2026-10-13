import { describe, expect, it } from 'vitest';

import {
  ACCESS_KEY_RANDOM_PART_LENGTH,
  AccessKeyPrefixSchema,
  AccessKeySecretSchema,
  GenerateAccessKeyRequestSchema,
  GenerateAccessKeyResponseSchema,
  ListAccessKeysResponseSchema,
  RevokeAccessKeyParamsSchema,
  RevokeAccessKeyResponseSchema,
} from '../access-keys.js';

const accessKeyId = '2f87e78f-7f3a-404a-a3a9-8786c9d7a145';
const createdAt = '2026-04-27T10:30:00.000Z';
const scriptRandom = 'abcDEF123_-abcDEF123_-abcDEF123_';
const selfReportedRandom = 'zyxWVU987_-zyxWVU987_-zyxWVU987_';
const scriptPlaintext = `tr_script_${scriptRandom}`;
const selfReportedPlaintext = `tr_self_reported_${selfReportedRandom}`;

describe('access key constants', () => {
  it('documents the 24-byte base64url output length used by generated keys', () => {
    expect(ACCESS_KEY_RANDOM_PART_LENGTH).toBe(32);
  });
});

describe('AccessKeySecretSchema', () => {
  it('accepts script and self-reported keys with exactly 32 base64url characters', () => {
    expect(AccessKeySecretSchema.parse(scriptPlaintext)).toBe(scriptPlaintext);
    expect(AccessKeySecretSchema.parse(selfReportedPlaintext)).toBe(selfReportedPlaintext);
  });

  it('rejects wrong scopes, wrong lengths, and non-base64url characters', () => {
    expect(() => AccessKeySecretSchema.parse(`tr_script_${scriptRandom.slice(0, 31)}`)).toThrow();
    expect(() => AccessKeySecretSchema.parse(`tr_script_${scriptRandom}x`)).toThrow();
    expect(() => AccessKeySecretSchema.parse(`tr_admin_${scriptRandom}`)).toThrow();
    expect(() => AccessKeySecretSchema.parse(`tr_script_${scriptRandom.slice(0, 31)}!`)).toThrow();
  });
});

describe('AccessKeyPrefixSchema', () => {
  it('accepts non-secret prefixes used for display and lookup hints', () => {
    expect(AccessKeyPrefixSchema.parse('tr_script_a')).toBe('tr_script_a');
    expect(AccessKeyPrefixSchema.parse('tr_self_rep')).toBe('tr_self_rep');
  });

  it('rejects full plaintext keys and invalid prefix characters', () => {
    expect(() => AccessKeyPrefixSchema.parse(scriptPlaintext)).toThrow();
    expect(() => AccessKeyPrefixSchema.parse('script_a')).toThrow();
    expect(() => AccessKeyPrefixSchema.parse('tr_script_*')).toThrow();
  });
});

describe('GenerateAccessKeyRequestSchema', () => {
  it('accepts the two supported access key scopes', () => {
    expect(GenerateAccessKeyRequestSchema.parse({ scope: 'script' })).toEqual({ scope: 'script' });
    expect(GenerateAccessKeyRequestSchema.parse({ scope: 'self_reported' })).toEqual({ scope: 'self_reported' });
  });

  it('rejects unknown scopes and extra body fields', () => {
    expect(() => GenerateAccessKeyRequestSchema.parse({ scope: 'admin' })).toThrow();
    expect(() => GenerateAccessKeyRequestSchema.parse({ scope: 'script', label: 'local machine' })).toThrow();
  });
});

describe('GenerateAccessKeyResponseSchema', () => {
  it('accepts one-time plaintext generation responses when prefix and scope match', () => {
    expect(GenerateAccessKeyResponseSchema.parse({
      id: accessKeyId,
      scope: 'script',
      prefix: 'tr_script_a',
      plaintext: scriptPlaintext,
      created_at: createdAt,
    })).toEqual({
      id: accessKeyId,
      scope: 'script',
      prefix: 'tr_script_a',
      plaintext: scriptPlaintext,
      created_at: createdAt,
    });
  });

  it('rejects responses with mismatched scope, mismatched prefix, or leaked hash metadata', () => {
    expect(() => GenerateAccessKeyResponseSchema.parse({
      id: accessKeyId,
      scope: 'self_reported',
      prefix: 'tr_script_a',
      plaintext: scriptPlaintext,
      created_at: createdAt,
    })).toThrow();

    expect(() => GenerateAccessKeyResponseSchema.parse({
      id: accessKeyId,
      scope: 'script',
      prefix: 'tr_script_z',
      plaintext: scriptPlaintext,
      created_at: createdAt,
    })).toThrow();

    expect(() => GenerateAccessKeyResponseSchema.parse({
      id: accessKeyId,
      scope: 'script',
      prefix: 'tr_script_a',
      plaintext: scriptPlaintext,
      key_sha256: 'f'.repeat(64),
      created_at: createdAt,
    })).toThrow();
  });
});

describe('ListAccessKeysResponseSchema', () => {
  it('accepts list responses with key metadata and no plaintext', () => {
    expect(ListAccessKeysResponseSchema.parse([
      {
        keyId: accessKeyId,
        keyPrefix: 'tr_script_a',
        scope: 'script',
        createdAt,
        revokedAt: null,
        lastUsedAt: null,
      },
      {
        keyId: '8df765fe-0ced-4812-8f5e-d48ed89cc5ca',
        keyPrefix: 'tr_self_rep',
        scope: 'self_reported',
        createdAt,
        revokedAt: '2026-04-27T12:30:00.000Z',
        lastUsedAt: '2026-04-27T11:30:00.000Z',
      },
    ])).toHaveLength(2);
  });

  it('rejects plaintext and key hashes on list items', () => {
    const item = {
      keyId: accessKeyId,
      keyPrefix: 'tr_script_a',
      scope: 'script',
      createdAt,
      revokedAt: null,
      lastUsedAt: null,
    };

    expect(() => ListAccessKeysResponseSchema.parse([
      { ...item, plaintext: scriptPlaintext },
    ])).toThrow();

    expect(() => ListAccessKeysResponseSchema.parse([
      { ...item, key_sha256: 'f'.repeat(64) },
    ])).toThrow();
  });
});

describe('RevokeAccessKeyParamsSchema', () => {
  it('accepts strict revoke route params keyed by key_id', () => {
    expect(RevokeAccessKeyParamsSchema.parse({ key_id: accessKeyId })).toEqual({ key_id: accessKeyId });
  });

  it('rejects invalid ids and extra route params', () => {
    expect(() => RevokeAccessKeyParamsSchema.parse({ key_id: 'not-a-uuid' })).toThrow();
    expect(() => RevokeAccessKeyParamsSchema.parse({ key_id: accessKeyId, force: true })).toThrow();
  });
});

describe('RevokeAccessKeyResponseSchema', () => {
  it('accepts the strict ok response', () => {
    expect(RevokeAccessKeyResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('rejects legacy and extra response fields', () => {
    expect(() => RevokeAccessKeyResponseSchema.parse({ revoked: true })).toThrow();
    expect(() => RevokeAccessKeyResponseSchema.parse({ ok: true, key_id: accessKeyId })).toThrow();
  });
});
