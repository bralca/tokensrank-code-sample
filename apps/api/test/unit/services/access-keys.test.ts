import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  computeKeyHash,
  extractScopeFromKey,
  generateAccessKey,
  isValidKeyFormat,
  verifyAccessKey,
} from '../../../src/services/access-keys';

const validRandomPart = 'abcDEF123_-abcDEF123_-abcDEF123_';
const alternateRandomPart = 'zyxWVU987_-zyxWVU987_-zyxWVU987_';
const scriptKey = `tr_script_${validRandomPart}`;
const selfReportedKey = `tr_self_reported_${alternateRandomPart}`;
const keyPattern = /^tr_(script|self_reported)_[A-Za-z0-9_-]{32}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

describe('computeKeyHash', () => {
  it('returns a 64-character lowercase hex SHA-256 hash', () => {
    expect(computeKeyHash(scriptKey)).toMatch(sha256Pattern);
  });

  it('is deterministic for the same plaintext', () => {
    expect(computeKeyHash(scriptKey)).toBe(computeKeyHash(scriptKey));
  });

  it('returns different hashes for different plaintext keys', () => {
    expect(computeKeyHash(scriptKey)).not.toBe(computeKeyHash(selfReportedKey));
  });

  it('hashes arbitrary plaintext without changing the output contract', () => {
    expect(computeKeyHash('tr_script_abc')).toMatch(sha256Pattern);
  });
});

describe('isValidKeyFormat', () => {
  it('accepts valid script keys', () => {
    expect(isValidKeyFormat(scriptKey)).toBe(true);
  });

  it('accepts valid self-reported keys', () => {
    expect(isValidKeyFormat(selfReportedKey)).toBe(true);
  });

  it('rejects keys with unknown scopes', () => {
    expect(isValidKeyFormat(`tr_admin_${validRandomPart}`)).toBe(false);
  });

  it('rejects keys with short random parts', () => {
    expect(isValidKeyFormat(`tr_script_${validRandomPart.slice(0, 31)}`)).toBe(false);
  });

  it('rejects keys with long random parts', () => {
    expect(isValidKeyFormat(`tr_script_${validRandomPart}x`)).toBe(false);
  });

  it('rejects random parts outside base64url characters', () => {
    expect(isValidKeyFormat(`tr_script_${validRandomPart.slice(0, 31)}!`)).toBe(false);
  });

  it('rejects missing product prefixes and empty values', () => {
    expect(isValidKeyFormat(`script_${validRandomPart}`)).toBe(false);
    expect(isValidKeyFormat('')).toBe(false);
  });

  it('validates the expected scope when provided', () => {
    expect(isValidKeyFormat(scriptKey, 'script')).toBe(true);
    expect(isValidKeyFormat(scriptKey, 'self_reported')).toBe(false);
    expect(isValidKeyFormat(selfReportedKey, 'self_reported')).toBe(true);
    expect(isValidKeyFormat(selfReportedKey, 'script')).toBe(false);
  });
});

describe('generateAccessKey', () => {
  it('generates valid script keys with the expected return shape', () => {
    const generated = generateAccessKey('script');

    expect(generated).toEqual({
      plaintext: expect.stringMatching(keyPattern),
      key_sha256: expect.stringMatching(sha256Pattern),
      key_prefix: generated.plaintext.slice(0, 11),
      scope: 'script',
    });
    expect(isValidKeyFormat(generated.plaintext, 'script')).toBe(true);
  });

  it('generates valid self-reported keys with the expected return shape', () => {
    const generated = generateAccessKey('self_reported');

    expect(generated).toEqual({
      plaintext: expect.stringMatching(keyPattern),
      key_sha256: expect.stringMatching(sha256Pattern),
      key_prefix: generated.plaintext.slice(0, 11),
      scope: 'self_reported',
    });
    expect(isValidKeyFormat(generated.plaintext, 'self_reported')).toBe(true);
  });

  it('generates a 32-character base64url random part', () => {
    const generated = generateAccessKey('script');
    const randomPart = generated.plaintext.replace('tr_script_', '');

    expect(randomPart).toHaveLength(32);
    expect(randomPart).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('uses the plaintext hash as key_sha256', () => {
    const generated = generateAccessKey('script');

    expect(generated.key_sha256).toBe(computeKeyHash(generated.plaintext));
  });

  it('sets key_prefix to the first 11 plaintext characters', () => {
    const scriptGenerated = generateAccessKey('script');
    const selfReportedGenerated = generateAccessKey('self_reported');

    expect(scriptGenerated.key_prefix).toBe(scriptGenerated.plaintext.slice(0, 11));
    expect(selfReportedGenerated.key_prefix).toBe(selfReportedGenerated.plaintext.slice(0, 11));
    expect(scriptGenerated.key_prefix).toHaveLength(11);
    expect(selfReportedGenerated.key_prefix).toHaveLength(11);
  });

  it('generates unique plaintext keys across sequential calls', () => {
    const keys = Array.from({ length: 5 }, () => generateAccessKey('script').plaintext);

    expect(new Set(keys).size).toBe(5);
  });

  it('generates unique hashes across sequential calls', () => {
    const hashes = Array.from({ length: 5 }, () => generateAccessKey('self_reported').key_sha256);

    expect(new Set(hashes).size).toBe(5);
  });
});

describe('verifyAccessKey', () => {
  it('returns true for a matching plaintext and stored hash', () => {
    const hash = computeKeyHash(scriptKey);

    expect(verifyAccessKey(scriptKey, hash)).toBe(true);
  });

  it('returns true when the matching key has the expected scope', () => {
    const hash = computeKeyHash(selfReportedKey);

    expect(verifyAccessKey(selfReportedKey, hash, 'self_reported')).toBe(true);
  });

  it('returns false when the expected scope does not match', () => {
    const hash = computeKeyHash(scriptKey);

    expect(verifyAccessKey(scriptKey, hash, 'self_reported')).toBe(false);
  });

  it('returns false for a mismatched hash', () => {
    expect(verifyAccessKey(scriptKey, computeKeyHash(selfReportedKey))).toBe(false);
  });

  it('returns false for invalid plaintext format', () => {
    expect(verifyAccessKey('invalid', computeKeyHash('invalid'))).toBe(false);
  });

  it('returns false for empty plaintext', () => {
    expect(verifyAccessKey('', computeKeyHash(''))).toBe(false);
  });

  it('returns false for invalid stored hash formats', () => {
    expect(verifyAccessKey(scriptKey, 'f'.repeat(63))).toBe(false);
    expect(verifyAccessKey(scriptKey, 'g'.repeat(64))).toBe(false);
    expect(verifyAccessKey(scriptKey, '')).toBe(false);
  });

  it('uses crypto.timingSafeEqual for hash comparison', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/services/access-keys.ts', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('timingSafeEqual(computedBuffer, storedBuffer)');
  });
});

describe('extractScopeFromKey', () => {
  it('returns script for valid script keys', () => {
    expect(extractScopeFromKey(scriptKey)).toBe('script');
  });

  it('returns self_reported for valid self-reported keys', () => {
    expect(extractScopeFromKey(selfReportedKey)).toBe('self_reported');
  });

  it('returns null for invalid format', () => {
    expect(extractScopeFromKey('tr_script_short')).toBeNull();
    expect(extractScopeFromKey(`tr_admin_${validRandomPart}`)).toBeNull();
  });

  it('returns null for empty values', () => {
    expect(extractScopeFromKey('')).toBeNull();
  });
});
