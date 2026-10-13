import type { z } from 'zod';

import type {
  AuthResponseSchema,
  AuthSignInSchema,
  AuthSignUpSchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
  ProfileResponseSchema,
  SessionSchema,
  SignUpConfirmationSchema,
  UserSchema,
} from '../schemas/auth.js';

export type AuthSignUp = z.infer<typeof AuthSignUpSchema>;
export type AuthSignIn = z.infer<typeof AuthSignInSchema>;
export type AuthPasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;
export type AuthPasswordResetConfirm = z.infer<typeof PasswordResetConfirmSchema>;
export type AuthSession = z.infer<typeof SessionSchema>;
export type AuthUser = z.infer<typeof UserSchema>;
export type AuthProfileResponse = z.infer<typeof ProfileResponseSchema>;
export type AuthResponseBody = z.infer<typeof AuthResponseSchema>;
export type AuthSignUpConfirmation = z.infer<typeof SignUpConfirmationSchema>;
