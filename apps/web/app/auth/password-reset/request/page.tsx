'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  PasswordResetRequestSchema,
  type PasswordResetRequest,
} from '../../../../../../packages/shared/src/schemas/auth';

import { AuthForm, type AuthFormValidationErrors } from '../../../../components/auth-form';
import { ApiFetchError, apiFetch } from '../../../../lib/api';

const COOLDOWN_SECONDS = 30;

const RESET_REQUEST_FIELDS = [
  {
    name: 'email',
    label: 'Email',
    type: 'email',
    autoComplete: 'email',
    placeholder: 'you@example.com',
  },
] satisfies Parameters<typeof AuthForm<PasswordResetRequest>>[0]['fields'];

function buildConfirmationMessage(email: string): string {
  return `If an account exists for ${email}, we've sent a password reset link. Check your inbox (and spam folder) within 10 minutes.`;
}

function mapResetRequestError(error: unknown): AuthFormValidationErrors<PasswordResetRequest> {
  if (!(error instanceof ApiFetchError)) {
    return {
      form: 'Network error. Please check your connection and try again.',
    };
  }

  if (error.code === 'rate_limited') {
    return {
      form: 'Too many password reset requests. Please try again later.',
    };
  }

  return {
    form: error.message,
  };
}

export default function PasswordResetRequestPage() {
  const [validationErrors, setValidationErrors] = useState<AuthFormValidationErrors<PasswordResetRequest>>({});
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  useEffect(() => {
    if (cooldownRemaining <= 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCooldownRemaining((remaining) => Math.max(0, remaining - 1));
    }, 1000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [cooldownRemaining]);

  async function handleSubmit(values: PasswordResetRequest): Promise<void> {
    setValidationErrors({});
    setConfirmationMessage('');

    try {
      await apiFetch('/api/auth/password-reset/request', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      setConfirmationMessage(buildConfirmationMessage(values.email));
      setCooldownRemaining(COOLDOWN_SECONDS);
    } catch (error) {
      setValidationErrors(mapResetRequestError(error));
    }
  }

  return (
    <section className="flex w-full flex-col gap-8" aria-labelledby="password-reset-request-title">
      <header className="flex flex-col gap-2">
        <p className="font-sans text-sm font-medium text-[var(--muted)]">
          Password reset
        </p>
        <h1 id="password-reset-request-title" className="text-2xl font-semibold text-[var(--ink)]">
          Send a reset link
        </h1>
        <p className="text-sm leading-6 text-[var(--muted)]">
          Enter the email for your TokensRank account.
        </p>
      </header>

      <AuthForm
        schema={PasswordResetRequestSchema}
        fields={RESET_REQUEST_FIELDS}
        submitLabel={cooldownRemaining > 0 ? `Try again in ${cooldownRemaining}s` : 'Send reset link'}
        loadingLabel="Sending..."
        validationErrors={validationErrors}
        disabled={cooldownRemaining > 0}
        successMessage={confirmationMessage}
        onSubmit={handleSubmit}
        footer={(
          <p>
            Remembered it?{' '}
            <Link className="text-[var(--accent-ink)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" href="/auth/sign-in">
              Sign in
            </Link>
          </p>
        )}
      />
    </section>
  );
}
