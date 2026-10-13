import { describe, expect, it } from 'vitest';

import { validateHandleFormat } from './validators';

describe('validateHandleFormat', () => {
  it.each([
    'abc',
    'a'.repeat(30),
    'user_123',
    'my-handle',
    'a_b-c',
    '123',
    '  builder_123  ',
  ])('accepts valid handle "%s"', (handle) => {
    expect(validateHandleFormat(handle)).toEqual({ valid: true });
  });

  it.each([
    '',
    '   ',
    'ab',
    'a'.repeat(31),
    'Abc',
    'My-Handle',
    'USER_123',
    'user.name',
    'user name',
    'user@123',
    'ümlaut',
  ])('rejects invalid handle "%s"', (handle) => {
    expect(validateHandleFormat(handle)).toEqual({
      valid: false,
      reason: 'invalid_format',
    });
  });
});
