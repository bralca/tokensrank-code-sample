'use client';

import { useEffect, useMemo, useState } from 'react';

import { ApiFetchError, apiFetch } from '../../lib/api';

export type AvailabilityState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'taken'
  | 'invalid_format'
  | 'reserved'
  | 'error';

export type AvailabilityResult = {
  state: AvailabilityState;
  available: boolean | null;
  reason?: string;
};

type HandleAvailabilityProps = {
  value: string;
  onAvailabilityChange?: (result: AvailabilityResult) => void;
};

type HandleCheckData = {
  available: boolean;
  reason?: string;
};

type HandleCheckResponse = HandleCheckData | {
  data: HandleCheckData;
};

const HANDLE_CHECK_DEBOUNCE_MS = 400;
const MIN_CHECKING_VISIBLE_MS = 80;

function unwrapHandleCheckResponse(response: HandleCheckResponse): HandleCheckData {
  if ('data' in response) {
    return response.data;
  }

  return response;
}

function invalidFormatReason(handle: string): string {
  const trimmedHandle = handle.trim();

  if (trimmedHandle.length < 3 || trimmedHandle.length > 30) {
    return 'between 3 and 30 characters';
  }

  if (trimmedHandle !== trimmedHandle.toLowerCase()) {
    return 'must be lowercase';
  }

  return 'letters, numbers, dash, and underscore only';
}

function resultFromResponse(handle: string, response: HandleCheckData): AvailabilityResult {
  if (response.available) {
    return {
      state: 'available',
      available: true,
    };
  }

  if (response.reason === 'reserved' || response.reason === 'that handle\'s reserved') {
    return {
      state: 'reserved',
      available: false,
      reason: 'that handle\'s reserved',
    };
  }

  if (response.reason === 'invalid_format') {
    return {
      state: 'invalid_format',
      available: false,
      reason: invalidFormatReason(handle),
    };
  }

  return {
    state: 'taken',
    available: false,
    reason: 'handle already taken',
  };
}

function resultFromError(error: unknown, handle: string): AvailabilityResult {
  if (!(error instanceof ApiFetchError)) {
    return {
      state: 'error',
      available: false,
      reason: 'could not check availability',
    };
  }

  if (error.status === 400 || error.code === 'invalid_handle' || error.code === 'invalid_request') {
    return {
      state: 'invalid_format',
      available: false,
      reason: invalidFormatReason(handle),
    };
  }

  if (error.status === 409 || error.code === 'handle_taken') {
    return {
      state: 'taken',
      available: false,
      reason: 'handle already taken',
    };
  }

  return {
    state: 'error',
    available: false,
    reason: error.message,
  };
}

function displayForResult(result: AvailabilityResult): {
  message: string;
  className: string;
} | null {
  if (result.state === 'checking') {
    return {
      message: 'checking…',
      className: 'animate-pulse text-tr-dim',
    };
  }

  if (result.state === 'available') {
    return {
      message: '✓ available',
      className: 'text-tr-accent',
    };
  }

  if (result.state === 'taken') {
    return {
      message: '× taken',
      className: 'text-tr-danger',
    };
  }

  if (result.state === 'invalid_format') {
    return {
      message: `× ${result.reason ?? 'must be lowercase'}`,
      className: 'text-tr-danger',
    };
  }

  if (result.state === 'reserved') {
    return {
      message: '× that handle\'s reserved',
      className: 'text-tr-danger',
    };
  }

  if (result.state === 'error') {
    return {
      message: 'couldn\'t check availability',
      className: 'text-tr-availability',
    };
  }

  return null;
}

export function HandleAvailability({
  value,
  onAvailabilityChange,
}: HandleAvailabilityProps) {
  const [result, setResult] = useState<AvailabilityResult>({
    state: 'idle',
    available: null,
  });

  const handle = useMemo(() => value.trim(), [value]);

  useEffect(() => {
    let isCurrent = true;

    const publish = (nextResult: AvailabilityResult) => {
      if (!isCurrent) {
        return;
      }

      setResult(nextResult);
      onAvailabilityChange?.(nextResult);
    };

    if (!handle) {
      publish({
        state: 'idle',
        available: null,
      });
      return () => {
        isCurrent = false;
      };
    }

    publish({
      state: 'idle',
      available: null,
    });

    const controller = new AbortController();
    const debounce = window.setTimeout(() => {
      const checkingStartedAt = window.performance.now();

      const publishAfterCheckingWindow = (nextResult: AvailabilityResult) => {
        const elapsed = window.performance.now() - checkingStartedAt;
        const remaining = Math.max(0, MIN_CHECKING_VISIBLE_MS - elapsed);

        window.setTimeout(() => {
          publish(nextResult);
        }, remaining);
      };

      publish({
        state: 'checking',
        available: null,
      });

      void apiFetch<HandleCheckResponse>(`/api/handle/check?h=${encodeURIComponent(handle)}`, {
        signal: controller.signal,
      })
        .then((response) => {
          publishAfterCheckingWindow(resultFromResponse(handle, unwrapHandleCheckResponse(response)));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          publishAfterCheckingWindow(resultFromError(error, handle));
        });
    }, HANDLE_CHECK_DEBOUNCE_MS);

    return () => {
      isCurrent = false;
      controller.abort();
      window.clearTimeout(debounce);
    };
  }, [handle, onAvailabilityChange]);

  const display = displayForResult(result);

  if (!handle || !display) {
    return null;
  }

  return (
    <span
      aria-atomic="true"
      aria-live="polite"
      className={[
        'pointer-events-none absolute right-3 top-1/2 -translate-y-1/2',
        'font-mono text-[12px] leading-none text-right transition-colors duration-150',
        display.className,
      ].join(' ')}
      data-state={result.state}
      data-testid="handle-availability"
      role="status"
    >
      {display.message}
    </span>
  );
}
