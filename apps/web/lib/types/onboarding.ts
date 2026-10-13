export type OnboardingMode = 'script' | 'self_reported';

export type OnboardingProfileMode = 'script_verified' | 'self_reported' | null;

export type OnboardingStep = 'not_started' | 'mode_chosen' | 'complete';

export type OnboardingAccessKey = {
  keyId: string;
  keyPrefix: string;
  maskedKey: string;
  scope: OnboardingMode;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type OnboardingMe = {
  userId: string;
  email: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  xHandle: string | null;
  mode: OnboardingProfileMode;
  onboardedAt: string | null;
  shareProjects: boolean;
  onboarding: {
    step: OnboardingStep;
  };
  accessKeys: OnboardingAccessKey[];
};

export type GeneratedOnboardingAccessKey = {
  id: string;
  scope: OnboardingMode;
  prefix: string;
  plaintext: string;
  created_at: string;
};

export type OnboardingSseEvent =
  | {
    type: 'connected' | 'log';
    message: string;
  }
  | {
    type: 'session';
    message?: string;
    data?: {
      session_id?: string;
    };
  }
  | {
    type: 'first_session';
    message?: string;
    data: {
      handle: string;
    };
  };

export type OnboardingWaitingSearchParams = {
  mode?: string | string[];
};
