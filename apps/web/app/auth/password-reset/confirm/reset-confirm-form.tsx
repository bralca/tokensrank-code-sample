'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';

import {
  PasswordResetConfirmSchema,
  PasswordSchema,
} from '../../../../../../packages/shared/src/schemas/auth';

import { AuthForm, type AuthFormValidationErrors } from '../../../../components/auth-form';
import { ApiFetchError, apiFetch } from '../../../../lib/api';

const ResetPasswordFormSchema = z.object({
  new_password: PasswordSchema,
  confirm_password: PasswordSchema,
}).strict().refine((values) => values.new_password === values.confirm_password, {
  path: ['confirm_password'],
  message: 'Passwords must match',
});

type ResetPasswordFormValues = z.infer<typeof ResetPasswordFormSchema>;

const RESET_CONFIRM_FIELDS = [
  {
    name: 'new_password',
    label: 'New password',
    type: 'password',
    autoComplete: 'new-password',
    placeholder: 'Minimum 8 characters',
  },
  {
    name: 'confirm_password',
    label: 'Confirm password',
    type: 'password',
    autoComplete: 'new-password',
    placeholder: 'Repeat new password',
  },
] satisfies Parameters<typeof AuthForm<ResetPasswordFormValues>>[0]['fields'];

function mapResetConfirmError(error: unknown): AuthFormValidationErrors<ResetPasswordFormValues> {
  if (!(error instanceof ApiFetchError)) {
    return {
      form: 'Network error. Please check your connection and try again.',
    };
  }

  if (error.code === 'invalid_token' || error.status === 401) {
    return {
      form: 'Password reset token is invalid or expired',
    };
  }

  if (error.code === 'password_breached') {
    return {
      new_password: 'This password has been breached in a known data breach. Please choose another.',
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

export function ResetConfirmForm({ token }: { token: string }) {
  const router = useRouter();
  const [validationErrors, setValidationErrors] = useState<AuthFormValidationErrors<ResetPasswordFormValues>>({});

  async function handleSubmit(values: ResetPasswordFormValues): Promise<void> {
    setValidationErrors({});

    const requestBody = PasswordResetConfirmSchema.parse({
      token,
      new_password: values.new_password,
    });

    try {
      await apiFetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      router.push('/auth/sign-in');
    } catch (error) {
      setValidationErrors(mapResetConfirmError(error));
    }
  }

  return (
    <AuthForm
      schema={ResetPasswordFormSchema}
      fields={RESET_CONFIRM_FIELDS}
      submitLabel="Reset password"
      loadingLabel="Resetting..."
      validationErrors={validationErrors}
      onSubmit={handleSubmit}
      footer={(
        <div className="flex flex-col gap-2">
          <p>
            Remembered it?{' '}
            <Link className="text-[var(--accent-ink)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" href="/auth/sign-in">
              Sign in
            </Link>
          </p>
          <p>
            Need a new link?{' '}
            <Link className="text-[var(--accent-ink)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" href="/auth/password-reset/request">
              Request a new reset link
            </Link>
          </p>
        </div>
      )}
    />
  );
}
