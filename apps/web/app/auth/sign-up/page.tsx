'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import {
  SignUpRequestSchema,
  type SignUpRequest,
} from '../../../../../packages/shared/src/schemas/auth';

import { AuthForm, type AuthFormValidationErrors } from '../../../components/auth-form';
import {
  HandleAvailability,
  type AvailabilityResult,
} from '../../components/HandleAvailability';
import { ApiFetchError, getApiBaseUrl } from '../../../lib/api';

const SIGN_UP_FIELDS = [
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
    autoComplete: 'new-password',
    placeholder: 'Minimum 8 characters',
  },
  {
    name: 'handle',
    label: 'Handle',
    type: 'text',
    autoComplete: 'username',
    placeholder: 'alex',
  },
] satisfies Parameters<typeof AuthForm<SignUpRequest>>[0]['fields'];

function mapSignUpError(error: unknown): AuthFormValidationErrors<SignUpRequest> {
  if (!(error instanceof ApiFetchError)) {
    return {
      form: 'Network error. Please check your connection and try again.',
    };
  }

  if (error.code === 'email_taken') {
    return {
      email: 'An account with this email already exists',
    };
  }

  if (error.code === 'password_breached') {
    return {
      password: 'This password has been breached in a known data breach. Please choose another.',
    };
  }

  if (error.code === 'invalid_handle' || error.code === 'handle_taken') {
    return {
      handle: error.message,
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

async function submitSignUp(values: SignUpRequest): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/auth/sign-up`, {
    method: 'POST',
    credentials: 'include',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(values),
  });

  if (response.ok || response.status === 302 || response.type === 'opaqueredirect') {
    return;
  }

  let message = `API request failed with status ${response.status}`;
  let code: string | undefined;
  let details: unknown;

  try {
    const body = await response.json() as { error?: { code?: string; message?: string; details?: unknown } };
    message = body.error?.message ?? message;
    code = body.error?.code;
    details = body.error?.details;
  } catch {
    const text = await response.text().catch(() => '');
    message = text || message;
  }

  throw new ApiFetchError(message, response.status, code, details);
}

export default function SignUpPage() {
  const router = useRouter();
  const [validationErrors, setValidationErrors] = useState<AuthFormValidationErrors<SignUpRequest>>({});
  const [handleValue, setHandleValue] = useState('');
  const [handleAvailable, setHandleAvailable] = useState<boolean | null>(null);

  const handleAvailabilityChange = useCallback((result: AvailabilityResult) => {
    setHandleAvailable(result.available);
  }, []);

  const fields = useMemo(() => {
    return SIGN_UP_FIELDS.map((field) => {
      if (field.name !== 'handle') {
        return field;
      }

      return {
        ...field,
        inputAdornment: (
          <HandleAvailability
            value={handleValue}
            onAvailabilityChange={handleAvailabilityChange}
          />
        ),
      };
    });
  }, [handleValue, handleAvailabilityChange]);

  const submitDisabled = handleAvailable !== true;
  const submitDisabledTitle = handleAvailable === false ? 'Handle not available' : undefined;

  async function handleSubmit(values: SignUpRequest): Promise<void> {
    setValidationErrors({});

    try {
      await submitSignUp(values);
      router.push('/onboarding');
    } catch (error) {
      setValidationErrors(mapSignUpError(error));
    }
  }

  return (
    <section className="flex w-full flex-col gap-8" aria-labelledby="sign-up-title">
      <header className="flex flex-col gap-2">
        <p className="font-sans text-sm font-medium text-[var(--muted)]">
          Create an account
        </p>
        <h1 id="sign-up-title" className="text-2xl font-semibold text-[var(--ink)]">
          Create your account
        </h1>
        <p className="text-sm leading-6 text-[var(--muted)]">
          Use email and password to start ranking verified token usage.
        </p>
      </header>

      <AuthForm
        schema={SignUpRequestSchema}
        fields={fields}
        submitLabel="Create account"
        loadingLabel="Signing up..."
        validationErrors={validationErrors}
        onFieldChange={(name, value) => {
          if (name === 'handle') {
            setHandleValue(value);
          }
        }}
        requireValid
        submitDisabled={submitDisabled}
        submitDisabledTitle={submitDisabledTitle}
        onSubmit={handleSubmit}
        footer={(
          <p>
            Already have an account?{' '}
            <Link className="text-[var(--accent-ink)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" href="/auth/sign-in">
              Sign in
            </Link>
          </p>
        )}
      />
    </section>
  );
}
