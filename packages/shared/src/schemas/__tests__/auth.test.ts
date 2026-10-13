import { describe, expect, it } from 'vitest';

import { RESERVED_HANDLES_ARRAY } from '../../constants/reserved-handles.js';
import {
  AuthSignInSchema,
  AuthSignUpSchema,
  EmailSchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
  PasswordSchema,
} from '../auth.js';
import { HandleSchema } from '../handle.js';

describe('EmailSchema', () => {
  it('accepts valid email addresses and normalizes case', () => {
    expect(EmailSchema.parse('USER@Example.COM')).toBe('user@example.com');
    expect(EmailSchema.parse('  person.name+tag@sub.example.co  ')).toBe('person.name+tag@sub.example.co');
  });

  it('rejects invalid email addresses and values longer than 254 characters', () => {
    expect(() => EmailSchema.parse('not-an-email')).toThrow();
    expect(() => EmailSchema.parse(`${'a'.repeat(245)}@example.com`)).toThrow();
  });
});

describe('PasswordSchema', () => {
  it('accepts passwords within the 8 to 128 character bounds', () => {
    expect(PasswordSchema.parse('8chars!!')).toBe('8chars!!');
    expect(PasswordSchema.parse('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('rejects passwords outside the length bounds', () => {
    expect(() => PasswordSchema.parse('short')).toThrow();
    expect(() => PasswordSchema.parse('a'.repeat(129))).toThrow();
  });
});

describe('HandleSchema', () => {
  it('trims handles and accepts valid lowercase formats', () => {
    expect(HandleSchema.parse('valid_user-123')).toBe('valid_user-123');
    expect(HandleSchema.parse('  abc  ')).toBe('abc');
  });

  it('rejects invalid handle formats', () => {
    expect(() => HandleSchema.parse('ab')).toThrow();
    expect(() => HandleSchema.parse('a'.repeat(31))).toThrow();
    expect(() => HandleSchema.parse('Valid_User-123')).toThrow();
    expect(() => HandleSchema.parse('user.name')).toThrow();
    expect(() => HandleSchema.parse('user name')).toThrow();
  });

  it('rejects every reserved handle', () => {
    expect(RESERVED_HANDLES_ARRAY).toHaveLength(26);

    for (const reservedHandle of RESERVED_HANDLES_ARRAY) {
      expect(() => HandleSchema.parse(reservedHandle)).toThrow();
    }
  });
});

describe('auth endpoint schemas', () => {
  const validEmail = 'builder@example.com';
  const validPassword = 'correct-horse-battery-staple';
  const validHandle = 'builder_123';

  it('validates strict sign-up payloads', () => {
    expect(AuthSignUpSchema.parse({
      email: validEmail.toUpperCase(),
      password: validPassword,
      handle: validHandle,
    })).toEqual({
      email: validEmail,
      password: validPassword,
      handle: validHandle,
    });

    expect(() => AuthSignUpSchema.parse({
      email: validEmail,
      password: validPassword,
      handle: validHandle,
      displayName: 'Builder',
    })).toThrow();

    expect(() => AuthSignUpSchema.parse({
      email: validEmail,
      password: validPassword,
      handle: validHandle,
      role: 'admin',
    })).toThrow();
  });

  it('validates strict sign-in payloads', () => {
    expect(AuthSignInSchema.parse({
      email: validEmail.toUpperCase(),
      password: validPassword,
    })).toEqual({
      email: validEmail,
      password: validPassword,
    });

    expect(() => AuthSignInSchema.parse({
      email: validEmail,
      password: validPassword,
      rememberMe: true,
    })).toThrow();
  });

  it('validates strict password reset request payloads', () => {
    expect(PasswordResetRequestSchema.parse({
      email: validEmail.toUpperCase(),
    })).toEqual({
      email: validEmail,
    });

    expect(() => PasswordResetRequestSchema.parse({
      email: validEmail,
      redirectTo: 'https://attacker.example',
    })).toThrow();
  });

  it('validates strict password reset confirmation payloads', () => {
    expect(PasswordResetConfirmSchema.parse({
      token: ' reset-token ',
      new_password: validPassword,
    })).toEqual({
      token: 'reset-token',
      new_password: validPassword,
    });

    expect(() => PasswordResetConfirmSchema.parse({
      token: 'reset-token',
      new_password: validPassword,
      access_token: 'legacy-field',
    })).toThrow();

    expect(() => PasswordResetConfirmSchema.parse({
      token: 'reset-token',
      newPassword: validPassword,
    })).toThrow();
  });
});
