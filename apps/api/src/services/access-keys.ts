import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { AccessKeyScope } from '@tokensrank/shared';

export type { AccessKeyScope } from '@tokensrank/shared';

export type GeneratedAccessKey = {
  plaintext: string;
  key_sha256: string;
  key_prefix: string;
  scope: AccessKeyScope;
};

const ACCESS_KEY_RANDOM_BYTES = 24;
const ACCESS_KEY_PATTERN = /^tr_(script|self_reported)_([A-Za-z0-9_-]{32})$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Computes the SHA-256 hex digest used for access-key storage and lookup.
 */
export function computeKeyHash(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Validates the plaintext access-key format and, when provided, its scope.
 */
export function isValidKeyFormat(
  plaintext: string,
  expectedScope?: AccessKeyScope,
): boolean {
  const match = ACCESS_KEY_PATTERN.exec(plaintext);

  if (!match) {
    return false;
  }

  return expectedScope ? match[1] === expectedScope : true;
}

/**
 * Generates a plaintext access key and its database-safe SHA-256 hash.
 *
 * The plaintext value must be shown to the user exactly once by callers and
 * must never be stored or logged.
 */
export function generateAccessKey(scope: AccessKeyScope): GeneratedAccessKey {
  const randomPart = randomBytes(ACCESS_KEY_RANDOM_BYTES).toString('base64url');
  const plaintext = `tr_${scope}_${randomPart}`;

  return {
    plaintext,
    key_sha256: computeKeyHash(plaintext),
    key_prefix: plaintext.slice(0, 11),
    scope,
  };
}

/**
 * Verifies a plaintext access key against a stored SHA-256 hash.
 *
 * Hash comparison is constant-time for valid SHA-256 hex inputs. Invalid
 * plaintext or stored-hash formats fail closed without throwing.
 */
export function verifyAccessKey(
  plaintext: string,
  storedKeySha256: string,
  expectedScope?: AccessKeyScope,
): boolean {
  if (!isValidKeyFormat(plaintext, expectedScope) || !SHA256_HEX_PATTERN.test(storedKeySha256)) {
    return false;
  }

  const computedHash = computeKeyHash(plaintext);
  const computedBuffer = Buffer.from(computedHash, 'hex');
  const storedBuffer = Buffer.from(storedKeySha256, 'hex');

  return timingSafeEqual(computedBuffer, storedBuffer);
}

/**
 * Extracts the access-key scope from a valid plaintext key.
 */
export function extractScopeFromKey(plaintext: string): AccessKeyScope | null {
  const match = ACCESS_KEY_PATTERN.exec(plaintext);

  if (!match) {
    return null;
  }

  if (match[1] === 'script') {
    return 'script';
  }

  return match[1] as AccessKeyScope;
}
