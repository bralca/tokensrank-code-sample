'use client';

import { useEffect } from 'react';
import { Brand } from '../app/components/dashboard/Brand';

type ErrorBoundaryFallbackProps = {
  error?: Error & {
    code?: string;
    digest?: string;
    status?: number;
  };
  reset?: () => void;
  title?: string;
  message?: string;
  homeHref?: string;
  homeLabel?: string;
  retryLabel?: string;
};

function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

export function ErrorBoundaryFallback({
  error,
  reset,
  title = 'Something went wrong',
  message = 'The page could not be loaded. Try again or return to the leaderboard.',
  homeHref = '/',
  homeLabel = 'Go home',
  retryLabel = 'Try again',
}: ErrorBoundaryFallbackProps) {
  useEffect(() => {
    if (isDevelopment() && error) {
      console.error('[web] Error boundary captured error', error);
    }
  }, [error]);

  return (
    <main className="dashboard dash-auth">
      <section
        role="alert"
        aria-live="assertive"
        className="dash-auth-card flex flex-col gap-6"
      >
        <Brand />
        <div className="flex flex-col gap-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-tr-error">
            Page error
          </p>
          <h1 className="text-2xl font-semibold text-tr-text">{title}</h1>
          <p className="text-sm leading-6 text-tr-secondary">{message}</p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          {reset ? (
            <button
              type="button"
              onClick={reset}
              className="dash-button primary"
              data-testid="error-boundary-retry"
            >
              {retryLabel}
            </button>
          ) : null}
          <a
            href={homeHref}
            className="dash-button"
            data-testid="error-boundary-home"
          >
            {homeLabel}
          </a>
        </div>
      </section>
    </main>
  );
}
