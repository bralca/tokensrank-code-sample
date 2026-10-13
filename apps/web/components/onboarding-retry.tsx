'use client';

export type OnboardingRetryError = {
  code?: string;
  message?: string;
  status?: number;
};

type OnboardingRetryProps = {
  error: OnboardingRetryError;
  onRetry: () => void;
  isRetrying?: boolean;
};

function retryMessage(error: OnboardingRetryError): string {
  const code = error.code?.toLowerCase();

  if (code === 'timeout' || code === 'network_timeout') {
    return 'Connection timed out. Check your network, then try again.';
  }

  if (code === 'unauthorized' || code === 'invalid_token' || error.status === 401) {
    return 'Your session or access key was rejected. Sign in again or generate a fresh key.';
  }

  if (code === 'rate_limited' || error.status === 429) {
    return 'Too many attempts were sent in a short window. Wait a moment, then retry.';
  }

  if (error.message) {
    return error.message;
  }

  return 'The onboarding check could not finish. Retry the request when you are ready.';
}

export function OnboardingRetry({ error, onRetry, isRetrying = false }: OnboardingRetryProps) {
  return (
    <section
      role="alert"
      className="rounded-md border border-tr-error/60 bg-tr-error/10 p-4 text-sm text-[var(--ink)]"
      data-testid="onboarding-retry"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-sans text-sm font-medium text-tr-error">
            Connection issue
          </p>
          <p className="leading-6 text-[var(--muted)]">{retryMessage(error)}</p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          className="dash-button primary "
          data-testid="onboarding-retry-button"
        >
          {isRetrying ? 'Retrying...' : 'Retry'}
        </button>
      </div>
    </section>
  );
}
