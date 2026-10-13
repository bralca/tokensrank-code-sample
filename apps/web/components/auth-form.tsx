'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  type DefaultValues,
  type FieldErrors,
  type FieldValues,
  type Path,
  type SubmitHandler,
  useForm,
} from 'react-hook-form';
import type { z } from 'zod';

export type AuthFormField<TValues extends FieldValues> = {
  name: Path<TValues>;
  label: string;
  type?: 'email' | 'password' | 'text';
  autoComplete?: string;
  placeholder?: string;
  helperText?: ReactNode;
  inputAdornment?: ReactNode;
};

export type AuthFormValidationErrors<TValues extends FieldValues> =
  Partial<Record<Path<TValues>, string>> & {
    form?: string;
  };

type AuthFormProps<TValues extends FieldValues> = {
  schema: z.ZodType<TValues>;
  fields: Array<AuthFormField<TValues>>;
  submitLabel: string;
  loadingLabel: string;
  onSubmit: (values: TValues) => Promise<void> | void;
  validationErrors?: AuthFormValidationErrors<TValues>;
  defaultValues?: Partial<TValues>;
  disabled?: boolean;
  requireValid?: boolean;
  submitDisabled?: boolean;
  submitDisabledTitle?: string;
  footer?: ReactNode;
  successMessage?: ReactNode;
  onFieldChange?: (name: Path<TValues>, value: string) => void;
};

function getErrorMessage<TValues extends FieldValues>(
  errors: FieldErrors<TValues>,
  name: Path<TValues>,
  validationErrors?: AuthFormValidationErrors<TValues>,
): string | undefined {
  const fieldError = errors[name];

  if (fieldError?.message && typeof fieldError.message === 'string') {
    return fieldError.message;
  }

  return validationErrors?.[name];
}

export function AuthForm<TValues extends FieldValues>({
  schema,
  fields,
  submitLabel,
  loadingLabel,
  onSubmit,
  validationErrors,
  defaultValues,
  disabled = false,
  requireValid = false,
  submitDisabled = false,
  submitDisabledTitle,
  footer,
  successMessage,
  onFieldChange,
}: AuthFormProps<TValues>) {
  const [isLoading, setIsLoading] = useState(false);
  const initialValues = useMemo(() => {
    return fields.reduce<Record<string, string>>((values, field) => {
      const key = field.name as string;
      const defaultValue = defaultValues?.[field.name];

      values[key] = typeof defaultValue === 'string' ? defaultValue : '';
      return values;
    }, {}) as DefaultValues<TValues>;
  }, [defaultValues, fields]);

  const {
    formState: { errors, isValid },
    handleSubmit,
    register,
    setError,
  } = useForm<TValues>({
    defaultValues: initialValues,
    mode: requireValid ? 'onChange' : 'onSubmit',
    reValidateMode: 'onChange',
    resolver: zodResolver(schema),
  });

  useEffect(() => {
    if (!validationErrors) {
      return;
    }

    for (const field of fields) {
      const message = validationErrors[field.name];

      if (message) {
        setError(field.name, {
          type: 'server',
          message,
        });
      }
    }
  }, [fields, setError, validationErrors]);

  const submitHandler: SubmitHandler<TValues> = async (values) => {
    setIsLoading(true);

    try {
      await onSubmit(values);
    } finally {
      setIsLoading(false);
    }
  };

  const isDisabled = disabled || isLoading;
  const isSubmitDisabled = isDisabled || submitDisabled || (requireValid && !isValid);

  return (
    <form
      noValidate
      onSubmit={handleSubmit(submitHandler)}
      className="flex w-full flex-col gap-5"
      data-testid="auth-form"
    >
      {validationErrors?.form ? (
        <div
          className="rounded-md border border-[#EF4444]/50 bg-[#EF4444]/10 px-3 py-2 text-sm leading-5 text-red-700"
          role="alert"
          data-testid="auth-form-error"
        >
          {validationErrors.form}
        </div>
      ) : null}

      {successMessage ? (
        <div
          className="rounded-md border border-[var(--accent)]/50 bg-[var(--accent-soft)]/10 px-3 py-2 text-sm leading-5 text-[var(--accent-ink)]"
          role="status"
          data-testid="auth-form-success"
        >
          {successMessage}
        </div>
      ) : null}

      {fields.map((field) => {
        const message = getErrorMessage(errors, field.name, validationErrors);

        return (
          <div className="flex flex-col gap-2" key={field.name}>
            <label
              htmlFor={field.name}
              className="font-sans text-sm font-medium text-[var(--muted)]"
            >
              {field.label}
            </label>
            <div className="relative">
              <input
                id={field.name}
                type={field.type ?? 'text'}
                autoComplete={field.autoComplete}
                placeholder={field.placeholder}
                disabled={isDisabled}
                aria-invalid={Boolean(message)}
                aria-describedby={message ? `${field.name}-error` : undefined}
                className="h-11 w-full rounded-md border border-[var(--line)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                data-testid={`auth-field-${field.name}`}
                {...register(field.name, {
                  onChange: (event) => {
                    onFieldChange?.(field.name, event.target.value);
                  },
                })}
              />
              {field.inputAdornment}
            </div>
            {field.helperText ? (
              <div className="text-xs leading-5 text-[var(--muted)]">
                {field.helperText}
              </div>
            ) : null}
            {message ? (
              <p
                id={`${field.name}-error`}
                className="text-sm leading-5 text-red-700"
                role="alert"
                data-testid={`auth-error-${field.name}`}
              >
                {message}
              </p>
            ) : null}
          </div>
        );
      })}

      <button
        type="submit"
        disabled={isSubmitDisabled}
        style={isSubmitDisabled ? { opacity: 0.6 } : undefined}
        title={submitDisabledTitle}
        className="dash-button primary w-full"
        data-testid="auth-submit"
      >
        {isLoading ? loadingLabel : submitLabel}
      </button>

      {footer ? (
        <div className="text-sm leading-6 text-[var(--muted)]">
          {footer}
        </div>
      ) : null}
    </form>
  );
}
