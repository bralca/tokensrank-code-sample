import { describe, expect, it } from 'vitest';

import {
  computeKeyHash,
  generateAccessKey,
  isValidKeyFormat,
} from '../../../src/services/access-keys';

const sha256HexPattern = /^[a-f0-9]{64}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]{32}$/;

describe('generateAccessKey', () => {
  it('generates script keys in the tr_<scope>_<32 base64url chars> format', () => {
    const generated = generateAccessKey('script');
    const randomPart = generated.plaintext.replace('tr_script_', '');

    expect(generated.plaintext).toMatch(/^tr_script_[A-Za-z0-9_-]{32}$/);
    expect(randomPart).toHaveLength(32);
    expect(randomPart).toMatch(base64UrlPattern);
    expect(generated.key_prefix).toBe(generated.plaintext.slice(0, 11));
    expect(generated.scope).toBe('script');
    expect(isValidKeyFormat(generated.plaintext, 'script')).toBe(true);
  });

  it('generates self-reported keys in the tr_<scope>_<32 base64url chars> format', () => {
    const generated = generateAccessKey('self_reported');
    const randomPart = generated.plaintext.replace('tr_self_reported_', '');

    expect(generated.plaintext).toMatch(/^tr_self_reported_[A-Za-z0-9_-]{32}$/);
    expect(randomPart).toHaveLength(32);
    expect(randomPart).toMatch(base64UrlPattern);
    expect(generated.key_prefix).toBe(generated.plaintext.slice(0, 11));
    expect(generated.scope).toBe('self_reported');
    expect(isValidKeyFormat(generated.plaintext, 'self_reported')).toBe(true);
  });

  it('computes a 64-character SHA-256 hex digest from the plaintext key', () => {
    const generated = generateAccessKey('script');

    expect(generated.key_sha256).toMatch(sha256HexPattern);
    expect(generated.key_sha256).toBe(computeKeyHash(generated.plaintext));
  });

  it('generates unique plaintext values and hashes', () => {
    const generated = Array.from({ length: 10 }, () => generateAccessKey('script'));

    expect(new Set(generated.map((key) => key.plaintext)).size).toBe(generated.length);
    expect(new Set(generated.map((key) => key.key_sha256)).size).toBe(generated.length);
  });
});
