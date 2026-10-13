import type { z } from 'zod';

import type {
  AccessKeyResponseSchema,
  OnboardingModeRequestSchema,
  OnboardingStatusResponseSchema,
  OnboardingStepSchema,
  PathChoiceSchema,
} from '../schemas/onboarding.js';

export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;
export type PathChoice = z.infer<typeof PathChoiceSchema>;
export type OnboardingModeRequest = z.infer<typeof OnboardingModeRequestSchema>;
export type AccessKeyResponse = z.infer<typeof AccessKeyResponseSchema>;
export type OnboardingStatusResponse = z.infer<typeof OnboardingStatusResponseSchema>;
