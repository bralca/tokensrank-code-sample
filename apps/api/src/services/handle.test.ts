import { RESERVED_HANDLES_ARRAY } from '@tokensrank/shared';
import { describe, expect, it } from 'vitest';

import {
  getHandleValidationReason,
  isReservedHandle,
  isValidHandle,
  normalizeHandle,
} from './handle';

describe('normalizeHandle', () => {
  it.each([
    ['Builder', 'builder'],
    ['  Builder_123  ', 'builder_123'],
    ['MY-HANDLE', 'my-handle'],
    ['\tMixed_Case-9\n', 'mixed_case-9'],
    ['', ''],
    ['   ', ''],
  ])('normalizes "%s" to "%s"', (input, expected) => {
    expect(normalizeHandle(input)).toBe(expected);
  });
});

describe('isValidHandle', () => {
  it.each([
    'abc',
    'a'.repeat(30),
    'user_123',
    'my-handle',
    'a_b-c',
    '123',
    '  builder_123  ',
  ])('accepts valid non-reserved handle "%s"', (handle) => {
    expect(isValidHandle(handle)).toBe(true);
  });

  it.each([
    'ab',
    'a'.repeat(31),
    'Abc',
    'My-Handle',
    'user.name',
    'user name',
    'user@123',
    'ümlaut',
    'admin',
  ])('rejects invalid or reserved handle "%s"', (handle) => {
    expect(isValidHandle(handle)).toBe(false);
  });
});

describe('isReservedHandle', () => {
  it.each(RESERVED_HANDLES_ARRAY)('matches reserved handle "%s"', (handle) => {
    expect(isReservedHandle(handle)).toBe(true);
  });

  it.each([
    ['Admin', true],
    ['  API  ', true],
    ['SIGN-UP', true],
    ['Leaderboard', true],
    ['builder', false],
    ['api-builder', false],
    ['token_user', false],
  ])('checks "%s" case-insensitively', (handle, expected) => {
    expect(isReservedHandle(handle)).toBe(expected);
  });
});

describe('getHandleValidationReason', () => {
  it.each([
    ['ab', 'between 3 and 30 characters'],
    ['a'.repeat(31), 'between 3 and 30 characters'],
    ['', 'between 3 and 30 characters'],
  ])('returns the length reason for "%s"', (handle, reason) => {
    expect(getHandleValidationReason(handle)).toBe(reason);
  });

  it.each([
    'Abc',
    'My-Handle',
    'USER_123',
  ])('returns the lowercase reason for "%s"', (handle) => {
    expect(getHandleValidationReason(handle)).toBe('must be lowercase');
  });

  it.each([
    'user.name',
    'user name',
    'user@123',
    'ümlaut',
  ])('returns the character reason for "%s"', (handle) => {
    expect(getHandleValidationReason(handle)).toBe('letters, numbers, dash, and underscore only');
  });

  it.each([
    'admin',
    'api',
    'leaderboard',
    '  sign-in  ',
  ])('returns the reserved reason for "%s"', (handle) => {
    expect(getHandleValidationReason(handle)).toBe('that handle\'s reserved');
  });

  it.each([
    'builder',
    'user_123',
    'my-handle',
    'a'.repeat(30),
  ])('returns undefined for valid available-format handle "%s"', (handle) => {
    expect(getHandleValidationReason(handle)).toBeUndefined();
  });
});
