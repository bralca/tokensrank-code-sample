'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  SignInRequestSchema,
  type SignInRequest,
} from '../../../../../packages/shared/src/schemas/auth';

import { AuthForm, type AuthFormValidationErrors } from '../../../components/auth-form';
import { ApiFetchError, apiFetch, getApiBaseUrl } from '../../../lib/api';

const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials';

const SIGN_IN_FIELDS = [
  {
    name: 'email',
    label: 'Email',
    type: 'email',
    autoComplete: 'email',
    placeholder: 'you@example.com',
  },
  {
    name: 'password',
    label: 'Password',
    type: 'password',
    autoComplete: 'current-password',
    placeholder: 'Your password',
  },
] satisfies Parameters<typeof AuthForm<SignInRequest>>[0]['fields'];

function mapSignInError(error: unknown): AuthFormValidationErrors<SignInRequest> {
  if (!(error instanceof ApiFetchError)) {
    return {
      form: 'Network error. Please check your connection and try again.',
    };
  }

  if (error.status === 401 || error.code === 'invalid_credentials') {
    return {
      form: INVALID_CREDENTIALS_MESSAGE,
    };
  }

  if (error.code === 'schema_invalid') {
    return {
      form: 'Please review the highlighted fields and try again.',
    };
  }

  return {
    form: error.message,
  };
}

export default function SignInPage() {
  const router = useRouter();
  const [validationErrors, setValidationErrors] = useState<AuthFormValidationErrors<SignInRequest>>({});

  async function handleSubmit(values: SignInRequest): Promise<void> {
    setValidationErrors({});

    try {
      await apiFetch('/api/auth/sign-in', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      router.push('/me');
    } catch (error) {
      setValidationErrors(mapSignInError(error));
    }
  }

  return (
    <section className="flex w-full flex-col gap-8" aria-labelledby="sign-in-title">
      <header className="flex flex-col gap-2">
        <p className="font-sans text-sm font-medium text-[var(--muted)]">
          Welcome back
        </p>
        <h1 id="sign-in-title" className="text-2xl font-semibold text-[var(--ink)]">
          Sign in to TokensRank
        </h1>
        <p className="text-sm leading-6 text-[var(--muted)]">
          Sign in to publish your usage and manage your public profile.
        </p>
      </header>

      <a
        href={`${getApiBaseUrl()}/api/auth/github/start`}
        className="dash-button dark w-full"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="18" height="18" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        Continue with GitHub
      </a>

      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-[var(--line)]" />
        <span className="font-sans text-xs text-[var(--muted)]">or email</span>
        <span className="h-px flex-1 bg-[var(--line)]" />
      </div>

      <AuthForm
        schema={SignInRequestSchema}
        fields={SIGN_IN_FIELDS}
        submitLabel="Sign in"
        loadingLabel="Signing in..."
        validationErrors={validationErrors}
        onSubmit={handleSubmit}
        footer={(
          <div className="flex flex-col gap-2">
            <Link className="text-[var(--accent-ink)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" href="/auth/password-reset/request">
              Forgot password?
            </Link>
            <p>
              Need an account?{' '}
              <Link className="text-[var(--accent-ink)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" href="/auth/sign-up">
                Sign up
              </Link>
            </p>
          </div>
        )}
      />
    </section>
  );
}
