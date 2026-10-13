'use client';

import { ErrorBoundaryFallback } from '../components/error-boundary';

type GlobalErrorProps = {
  error: Error & {
    digest?: string;
  };
  reset: () => void;
};

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  return (
    <ErrorBoundaryFallback
      error={error}
      reset={reset}
      title="TokensRank hit a page error"
      message="The current view could not be rendered. Retry the page or return to the leaderboard."
      homeHref="/"
      homeLabel="View leaderboard"
      retryLabel="Try again"
    />
  );
}
