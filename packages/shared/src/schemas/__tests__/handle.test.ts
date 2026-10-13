import { describe, expect, it } from 'vitest';

import { RESERVED_HANDLES, RESERVED_HANDLES_ARRAY } from '../../constants/reserved-handles.js';
import {
  HANDLE_PATTERN,
  HandleSchema,
  isReservedHandle,
  isValidHandle,
  normalizeHandle,
} from '../handle.js';

describe('reserved handle constants', () => {
  it('exports exactly 26 unique reserved handles', () => {
    expect(RESERVED_HANDLES_ARRAY).toHaveLength(26);
    expect(RESERVED_HANDLES).toHaveLength(26);
    expect(new Set(RESERVED_HANDLES_ARRAY).size).toBe(26);
  });

  it.each([
    'admin',
    'api',
    'auth',
    'dashboard',
    'leaderboard',
    'cdn',
    'assets',
  ])('includes route and infrastructure handle "%s"', (handle) => {
    expect(RESERVED_HANDLES).toContain(handle);
  });
});

describe('normalizeHandle', () => {
  it.each([
    ['Alice', 'alice'],
    ['  Builder_123  ', 'builder_123'],
    ['MY-HANDLE', 'my-handle'],
    ['Already_Lower', 'already_lower'],
    ['  MiXeD-case_9  ', 'mixed-case_9'],
  ])('normalizes "%s" to "%s"', (input, expected) => {
    expect(normalizeHandle(input)).toBe(expected);
  });
});

describe('isReservedHandle', () => {
  it.each([
    'admin',
    'Admin',
    '  API  ',
    'Leaderboard',
    'sign-in',
    'SIGN-UP',
    'assets',
  ])('matches reserved handle "%s" case-insensitively', (handle) => {
    expect(isReservedHandle(handle)).toBe(true);
  });

  it.each([
    'builder',
    'token_user',
    'rank-123',
    'notreserved',
  ])('does not match available handle "%s"', (handle) => {
    expect(isReservedHandle(handle)).toBe(false);
  });
});

describe('HandleSchema', () => {
  it.each([
    'abc',
    'user_123',
    'my-handle',
    'a_b-c',
    '123',
    'a'.repeat(30),
  ])('accepts valid handle "%s"', (handle) => {
    expect(HandleSchema.parse(handle)).toBe(handle);
  });

  it('trims valid handles before returning them', () => {
    expect(HandleSchema.parse('  builder_123  ')).toBe('builder_123');
  });

  it.each([
    'Abc',
    'My-Handle',
    'USER_123',
    'miXed',
  ])('rejects uppercase handle "%s"', (handle) => {
    expect(() => HandleSchema.parse(handle)).toThrow();
  });

  it.each([
    'ab',
    'xy',
    '',
  ])('rejects too-short handle "%s"', (handle) => {
    expect(() => HandleSchema.parse(handle)).toThrow();
  });

  it('rejects handles longer than 30 characters', () => {
    expect(() => HandleSchema.parse('a'.repeat(31))).toThrow();
  });

  it.each([
    'user.name',
    'user name',
    'user@123',
    'user/123',
    'ümlaut',
  ])('rejects invalid characters in "%s"', (handle) => {
    expect(() => HandleSchema.parse(handle)).toThrow();
  });

  it.each(RESERVED_HANDLES_ARRAY)('rejects reserved handle "%s"', (reservedHandle) => {
    expect(() => HandleSchema.parse(reservedHandle)).toThrow('That handle\'s reserved');
  });
});

describe('isValidHandle', () => {
  it.each([
    'builder',
    'token_ranker',
    'codex-user',
    'z9_8-7',
  ])('returns true for valid non-reserved handle "%s"', (handle) => {
    expect(isValidHandle(handle)).toBe(true);
  });

  it.each([
    'Admin',
    'admin',
    'ab',
    'a'.repeat(31),
    'has space',
    'has.dot',
  ])('returns false for invalid or reserved handle "%s"', (handle) => {
    expect(isValidHandle(handle)).toBe(false);
  });
});

describe('HANDLE_PATTERN', () => {
  it('matches the FR-12 handle regex exactly', () => {
    expect(HANDLE_PATTERN.source).toBe('^[a-z0-9_-]{3,30}$');
  });
});
