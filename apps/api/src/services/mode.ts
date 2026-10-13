export type IngestionEndpoint = 'script' | 'self-reported';
export type ProfileMode = 'script_verified' | 'self_reported' | null;
export type IngestionMode = Exclude<ProfileMode, null>;

export type ModeEscalationResult = {
  escalated: boolean;
  previousMode: ProfileMode;
  currentMode: ProfileMode;
};

export type ModeEscalationOptions = {
  dryRun?: boolean;
};

type ProfileModeRow = {
  mode: ProfileMode;
};

type SupabaseSingleResponse<T> = Promise<{
  data: T | null;
  error: { message: string } | null;
}>;

type SupabaseSelectQuery<T> = {
  eq(column: string, value: unknown): SupabaseSelectQuery<T>;
  single(): SupabaseSingleResponse<T>;
  maybeSingle(): SupabaseSingleResponse<T>;
};

type SupabaseUpdateQuery<T> = {
  eq(column: string, value: unknown): SupabaseUpdateQuery<T>;
  or(filters: string): SupabaseUpdateQuery<T>;
  select(columns: string): SupabaseUpdateQuery<T>;
  maybeSingle(): SupabaseSingleResponse<T>;
};

type SupabaseQueryBuilder = {
  select(columns: string): SupabaseSelectQuery<ProfileModeRow>;
  update(payload: Record<string, unknown>): SupabaseUpdateQuery<ProfileModeRow>;
};

type SupabaseModeClient = {
  from(table: 'profiles'): unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function includesIngestionModeField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => includesIngestionModeField(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(([key, nestedValue]) => (
    key === 'ingestion_mode' || includesIngestionModeField(nestedValue)
  ));
}

/**
 * Stamps a session's ingestion mode from the endpoint that handled the request.
 *
 * FR-33 makes the route the only source of truth: `/api/script/sessions`
 * produces `script_verified`, while `/api/self-reported/sessions` produces
 * `self_reported`. Request payloads cannot choose or override this value.
 */
export function determineIngestionMode(endpoint: IngestionEndpoint): IngestionMode {
  if (endpoint === 'script') {
    return 'script_verified';
  }

  return 'self_reported';
}

/**
 * Rejects client-supplied ingestion mode before persistence.
 *
 * FR-33 requires mode to be determined by the endpoint hit, not payload
 * contents. Call this after strict payload parsing and before insert mapping
 * so route handlers cannot accidentally trust a spoofed mode field.
 */
export function validatePayloadDoesNotIncludeIngestionMode(payload: unknown): void {
  if (includesIngestionModeField(payload)) {
    throw new Error('ingestion_mode is determined by endpoint and cannot be supplied in payload');
  }
}

/**
 * Returns whether a profile mode transition is an allowed one-way escalation.
 *
 * Mode escalation is B-to-A only: NULL/self_reported may become
 * script_verified, and script_verified is terminal. No downgrade is allowed.
 */
export function canEscalateMode(currentMode: ProfileMode, newMode: IngestionMode): boolean {
  return newMode === 'script_verified'
    && (currentMode === null || currentMode === 'self_reported');
}

/**
 * Escalates `profiles.mode` without touching historical sessions.
 *
 * Only the current profile row may change. Existing `sessions.ingestion_mode`
 * values remain as originally stamped, so Mode B history is never
 * retroactively re-tagged when a user later installs the script.
 */
export async function escalateProfileMode(
  supabase: SupabaseModeClient,
  profileId: string,
  newMode: IngestionMode,
  options: ModeEscalationOptions = {},
): Promise<ModeEscalationResult> {
  const profiles = supabase.from('profiles') as SupabaseQueryBuilder;
  const { data, error } = await profiles
    .select('mode')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`profile mode lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  if (newMode !== 'script_verified') {
    throw new Error('profile mode escalation only supports script_verified');
  }

  if (!canEscalateMode(data.mode, newMode)) {
    return {
      escalated: false,
      previousMode: data.mode,
      currentMode: data.mode,
    };
  }

  if (options.dryRun) {
    return {
      escalated: false,
      previousMode: data.mode,
      currentMode: data.mode,
    };
  }

  const { data: updatedProfile, error: updateError } = await (supabase.from('profiles') as SupabaseQueryBuilder)
    .update({
      mode: 'script_verified',
      verified: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', profileId)
    .or('mode.is.null,mode.eq.self_reported')
    .select('mode')
    .maybeSingle();

  if (updateError) {
    throw new Error(`profile mode escalation failed: ${updateError.message}`);
  }

  if (!updatedProfile) {
    const { data: currentProfile, error: refreshError } = await (supabase.from('profiles') as SupabaseQueryBuilder)
      .select('mode')
      .eq('id', profileId)
      .single();

    if (refreshError || !currentProfile) {
      throw new Error(`profile mode refresh failed: ${refreshError?.message ?? 'missing profile'}`);
    }

    return {
      escalated: false,
      previousMode: data.mode,
      currentMode: currentProfile.mode,
    };
  }

  return {
    escalated: true,
    previousMode: data.mode,
    currentMode: updatedProfile.mode,
  };
}
