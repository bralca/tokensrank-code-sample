import { z } from 'zod';

import { HandleSchema } from './handle.js';

export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address')
  .max(254, 'Email must be at most 254 characters');

export const AuthSignUpSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  handle: HandleSchema,
}).strict();

export const SignUpRequestSchema = AuthSignUpSchema;

export type AuthSignUpRequest = z.infer<typeof AuthSignUpSchema>;
export type SignUpRequest = z.infer<typeof AuthSignUpSchema>;

export const AuthSignInSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
}).strict();

export const SignInRequestSchema = AuthSignInSchema;

export type AuthSignInRequest = z.infer<typeof AuthSignInSchema>;
export type SignInRequest = z.infer<typeof AuthSignInSchema>;

export const PasswordResetRequestSchema = z.object({
  email: EmailSchema,
}).strict();

export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordResetConfirmSchema = z.object({
  token: z.string().trim().min(1, 'Password reset token is required'),
  new_password: PasswordSchema,
}).strict();

export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirmSchema>;

// Session response (from Supabase Auth)
export const SessionSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number().optional(),
  expires_in: z.number().optional(),
  token_type: z.literal('bearer').optional(),
}).strict();

export type Session = z.infer<typeof SessionSchema>;

// User response
export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type User = z.infer<typeof UserSchema>;

// Profile response
export const ProfileResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  handle: HandleSchema.nullable(),
  display_name: z.string().nullable(),
  avatar_url: z.string().url().nullable(),
  bio: z.string().nullable(),
  x_handle: z.string().nullable(),
  mode: z.enum(['script_verified', 'self_reported']).nullable(),
  verified: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

// Complete auth response for sign-up/sign-in
export const AuthResponseSchema = z.object({
  session: SessionSchema.optional(),
  user: UserSchema,
  profile: ProfileResponseSchema,
}).strict();

export type AuthResponse = z.infer<typeof AuthResponseSchema>;

// Sign-up confirmation status
export const SignUpConfirmationSchema = z.object({
  status: z.enum(['confirm_email_sent', 'authenticated']),
  session: SessionSchema.optional(),
  user: UserSchema.optional(),
  profile: ProfileResponseSchema.optional(),
}).strict();

export type SignUpConfirmation = z.infer<typeof SignUpConfirmationSchema>;
