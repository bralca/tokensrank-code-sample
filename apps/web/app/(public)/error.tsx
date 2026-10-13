'use client';

import { ErrorBoundaryFallback } from '../../components/error-boundary';

type PublicErrorProps = {
  error: Error & {
    code?: string;
    digest?: string;
    status?: number;
  };
  reset: () => void;
};

function isProfileNotFound(error: PublicErrorProps['error']): boolean {
  return error.code === 'profile_not_found'
    || error.status === 404
    || error.message.toLowerCase().includes('profile_not_found')
    || error.message.toLowerCase().includes('profile not found');
}

export default function PublicError({ error, reset }: PublicErrorProps) {
  if (isProfileNotFound(error)) {
    return (
      <ErrorBoundaryFallback
        error={error}
        reset={reset}
        title="Profile not found"
        message="That builder profile does not exist yet. View the leaderboard or try loading this profile again."
        homeHref="/"
        homeLabel="View all builders"
        retryLabel="Try again"
      />
    );
  }

  return (
    <ErrorBoundaryFallback
      error={error}
      reset={reset}
      title="Public page unavailable"
      message="This public page could not be loaded. Retry the request or return to the leaderboard."
      homeHref="/"
      homeLabel="View all builders"
      retryLabel="Try again"
    />
  );
}
