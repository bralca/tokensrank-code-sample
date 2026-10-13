import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { safeCompareTokens } from '../../../src/services/crypto';

describe('safeCompareTokens', () => {
  it('returns true for identical ASCII tokens', () => {
    expect(safeCompareTokens('tr_admin_secret', 'tr_admin_secret')).toBe(true);
  });

  it('returns false when tokens differ at the first byte', () => {
    expect(safeCompareTokens('xr_admin_secret', 'tr_admin_secret')).toBe(false);
  });

  it('returns false when tokens differ in the middle', () => {
    expect(safeCompareTokens('tr_admin_secrex', 'tr_admin_secret')).toBe(false);
  });

  it('returns false when tokens differ at the last byte', () => {
    expect(safeCompareTokens('tr_admin_secreu', 'tr_admin_secret')).toBe(false);
  });

  it('returns false when the provided token is shorter', () => {
    expect(safeCompareTokens('tr_admin', 'tr_admin_secret')).toBe(false);
  });

  it('returns false when the provided token is longer', () => {
    expect(safeCompareTokens('tr_admin_secret_extra', 'tr_admin_secret')).toBe(false);
  });

  it('returns false for an empty provided token', () => {
    expect(safeCompareTokens('', 'tr_admin_secret')).toBe(false);
  });

  it('returns false for an empty expected token with provided content', () => {
    expect(safeCompareTokens('tr_admin_secret', '')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(safeCompareTokens('', '')).toBe(true);
  });

  it('handles tokens with punctuation', () => {
    expect(safeCompareTokens('tr-admin.secret_123', 'tr-admin.secret_123')).toBe(true);
    expect(safeCompareTokens('tr-admin.secret_123', 'tr-admin.secret_124')).toBe(false);
  });

  it('handles base64url-style tokens', () => {
    const token = 'abcDEF123_-abcDEF123_-abcDEF123_';

    expect(safeCompareTokens(token, token)).toBe(true);
  });

  it('handles UTF-8 tokens with matching multibyte characters', () => {
    expect(safeCompareTokens('token-cafe-é', 'token-cafe-é')).toBe(true);
  });

  it('rejects UTF-8 tokens with different multibyte characters', () => {
    expect(safeCompareTokens('token-cafe-é', 'token-cafe-è')).toBe(false);
  });

  it('rejects canonically different Unicode strings', () => {
    expect(safeCompareTokens('token-e\u0301', 'token-é')).toBe(false);
  });

  it('handles newline characters as literal token bytes', () => {
    expect(safeCompareTokens('token\nvalue', 'token\nvalue')).toBe(true);
    expect(safeCompareTokens('token\nvalue', 'token value')).toBe(false);
  });

  it('uses crypto.timingSafeEqual without mocking crypto functions', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/services/crypto.ts', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('timingSafeEqual');
    expect(source).toContain('Buffer.alloc(comparisonLength)');
  });
});
