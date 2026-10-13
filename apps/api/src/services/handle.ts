import { HANDLE_PATTERN, HandleSchema, isReservedHandle as isReservedSharedHandle } from '@tokensrank/shared';

export type HandleValidationReason =
  | 'must be lowercase'
  | 'between 3 and 30 characters'
  | 'letters, numbers, dash, and underscore only'
  | 'that handle\'s reserved';

export type HandleAvailabilityReason = HandleValidationReason | 'handle already taken';

export type HandleAvailabilityResult = {
  available: boolean;
  reason?: HandleAvailabilityReason;
};

type HandleLookupResponse = {
  data: unknown;
  error: { message: string } | null;
};

type HandleMaybeSingleQuery = {
  maybeSingle(): PromiseLike<HandleLookupResponse>;
};

type HandleLimitQuery = {
  limit(count: number): HandleMaybeSingleQuery;
};

type HandleIlikeQuery = {
  ilike(column: string, pattern: string): HandleLimitQuery;
};

type HandleSelectQuery = {
  select(columns: string): HandleIlikeQuery;
};

export type HandleLookupClient = {
  from(table: 'profiles'): HandleSelectQuery;
};

export function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

export function isReservedHandle(handle: string): boolean {
  return isReservedSharedHandle(normalizeHandle(handle));
}

export function isValidHandle(handle: string): boolean {
  return HandleSchema.safeParse(handle).success;
}

export function getHandleValidationReason(handle: string): HandleValidationReason | undefined {
  const trimmedHandle = handle.trim();

  if (trimmedHandle.length < 3 || trimmedHandle.length > 30) {
    return 'between 3 and 30 characters';
  }

  if (trimmedHandle !== trimmedHandle.toLowerCase()) {
    return 'must be lowercase';
  }

  if (!HANDLE_PATTERN.test(trimmedHandle)) {
    return 'letters, numbers, dash, and underscore only';
  }

  if (isReservedHandle(trimmedHandle)) {
    return 'that handle\'s reserved';
  }

  return undefined;
}

function escapeIlikePattern(handle: string): string {
  return handle.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function checkHandleAvailability(
  db: HandleLookupClient,
  handle: string,
): Promise<HandleAvailabilityResult> {
  const validationReason = getHandleValidationReason(handle);

  if (validationReason) {
    return {
      available: false,
      reason: validationReason,
    };
  }

  const normalizedHandle = normalizeHandle(handle);

  try {
    const { data, error } = await db
      .from('profiles')
      .select('id')
      .ilike('handle', escapeIlikePattern(normalizedHandle))
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (data) {
      return {
        available: false,
        reason: 'handle already taken',
      };
    }

    return {
      available: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown database error';

    throw new Error(`[handle] Availability lookup failed: ${message}`);
  }
}
