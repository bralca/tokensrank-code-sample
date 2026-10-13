import { describe, expect, it } from 'vitest';

import { AuthSignUpSchema } from '@tokensrank/shared';

const validSignUpPayload = {
  email: 'builder@example.com',
  password: 'correct-horse-battery-staple',
  handle: 'builder_123',
};

function parseInvalidEmail(email: string) {
  return AuthSignUpSchema.safeParse({
    ...validSignUpPayload,
    email,
  });
}

function parseInvalidHandle(handle: string) {
  return AuthSignUpSchema.safeParse({
    ...validSignUpPayload,
    handle,
  });
}

describe('AuthSignUpSchema email validation', () => {
  it.each([
    'not-an-email',
    '@example.com',
    'builder@',
    'builder name@example.com',
  ])('rejects invalid email format %s with the canonical message', (email) => {
    const result = parseInvalidEmail(email);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['email'],
            message: 'Invalid email address',
          }),
        ]),
      );
    }
  });

  it('normalizes valid email case before returning parsed sign-up data', () => {
    const result = AuthSignUpSchema.safeParse({
      ...validSignUpPayload,
      email: 'Builder.Name+Tag@Example.COM',
    });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.email).toBe('builder.name+tag@example.com');
    }
  });
});

describe('AuthSignUpSchema handle validation', () => {
  it.each([
    ['ab', 'Handle must be 3-30 characters and use only lowercase letters, numbers, underscores, and hyphens'],
    ['a'.repeat(31), 'Handle must be 3-30 characters and use only lowercase letters, numbers, underscores, and hyphens'],
    ['Builder_123', 'Handle must be 3-30 characters and use only lowercase letters, numbers, underscores, and hyphens'],
    ['builder.name', 'Handle must be 3-30 characters and use only lowercase letters, numbers, underscores, and hyphens'],
    ['builder name', 'Handle must be 3-30 characters and use only lowercase letters, numbers, underscores, and hyphens'],
    ['admin', 'That handle\'s reserved'],
  ])('rejects invalid handle %s with the canonical message', (handle, message) => {
    const result = parseInvalidHandle(handle);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['handle'],
            message,
          }),
        ]),
      );
    }
  });

  it.each([
    'abc',
    'builder_123',
    'builder-123',
    'a_b-c',
    'a'.repeat(30),
  ])('accepts valid handle format %s', (handle) => {
    const result = AuthSignUpSchema.safeParse({
      ...validSignUpPayload,
      handle,
    });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.handle).toBe(handle);
    }
  });
});
