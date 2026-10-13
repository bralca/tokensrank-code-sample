const DEFAULT_POSTGREST_SCHEMA_RETRY_DELAYS_MS = [150, 300, 600] as const;

type RetryLogger = {
  warn: (bindings: Record<string, unknown>, message: string) => void;
};

type RetryOptions = {
  context: string;
  delaysMs?: readonly number[];
  event: string;
  logger?: RetryLogger;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;

    if (typeof message === 'string') {
      return message;
    }
  }

  return String(error);
}

export function isTransientPostgrestSchemaCacheError(error: unknown): boolean {
  const code = errorCode(error);
  const normalizedMessage = errorMessage(error).toLowerCase();

  return code === 'PGRST205'
    || code === 'PGRST106'
    || normalizedMessage.includes('schema cache')
    || normalizedMessage.includes('could not find the table');
}

export async function withPostgrestSchemaRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const delaysMs = options.delaysMs ?? DEFAULT_POSTGREST_SCHEMA_RETRY_DELAYS_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientPostgrestSchemaCacheError(error) || attempt === delaysMs.length) {
        throw error;
      }

      lastError = error;
      options.logger?.warn({
        event: options.event,
        context: options.context,
        attempt: attempt + 1,
        error_code: errorCode(error),
        error: errorMessage(error),
      }, 'Retrying after transient PostgREST schema cache miss');

      const delay = delaysMs[attempt];

      if (delay === undefined) {
        throw error;
      }

      await sleep(delay);
    }
  }

  throw lastError;
}
