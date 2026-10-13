import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const workerSchemaPrefix = 'tokensrank_test_w';
const workerSchemaCount = 4;
const defaultPassword = 'correct-horse-battery-staple';

export type WorkerId = string | number;

export type TestProfileMode = 'script_verified' | 'self_reported';

export type ResetTestDatabaseOptions = {
  workerId?: WorkerId;
  schema?: string;
};

export type SeedTestDatabaseOptions = ResetTestDatabaseOptions & {
  label?: string;
  profileCount?: number;
  sessionsPerProfile?: number;
  mode?: TestProfileMode;
};

export type SeededTestProfile = {
  id: string;
  userId: string;
  handle: string;
  email: string;
  mode: TestProfileMode;
};

export type SeedTestDatabaseResult = {
  schema: string;
  profiles: SeededTestProfile[];
  sessionCount: number;
};

type FixtureSupabaseClient = SupabaseClient<any, any, string, any, any>;
type SchemaClient = FixtureSupabaseClient;

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[test-fixtures] Missing required environment variable: ${name}`);
  }

  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSchemaCacheMiss(error: { message?: string; code?: string } | null): boolean {
  const message = error?.message ?? '';
  const code = error?.code ?? '';

  return code === 'PGRST106'
    || code === 'PGRST205'
    || message.includes('schema cache')
    || message.includes('Could not find the table');
}

export function resolveWorkerIndex(workerId: WorkerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'): number {
  const parsed = typeof workerId === 'number' ? workerId : Number.parseInt(workerId, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed % workerSchemaCount;
}

export function resolveTestSchema(workerId?: WorkerId): string {
  return `${workerSchemaPrefix}${resolveWorkerIndex(workerId)}`;
}

export function createServiceRoleClient(): FixtureSupabaseClient {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

export function createSchemaServiceRoleClient(schema: string): SchemaClient {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      db: {
        schema,
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          'Accept-Profile': schema,
          'Content-Profile': schema,
        },
      },
    },
  );
}

function resolveSchema(options: ResetTestDatabaseOptions = {}): string {
  return options.schema ?? resolveTestSchema(options.workerId);
}

export async function resetTestDatabase(options: ResetTestDatabaseOptions = {}): Promise<{ schema: string }> {
  const schema = resolveSchema(options);
  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient.rpc('reset_test_schema', {
    schema_name: schema,
  });

  if (error) {
    throw new Error(`[test-fixtures] reset_test_schema failed for ${schema}: ${error.message}`);
  }

  return { schema };
}

async function waitForProfile(schemaClient: SchemaClient, profileId: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await schemaClient
      .from('profiles')
      .select('id')
      .eq('id', profileId)
      .maybeSingle();

    if (!error && data) {
      return;
    }

    if (error && !isSchemaCacheMiss(error)) {
      throw new Error(`[test-fixtures] profile lookup failed: ${error.message}`);
    }

    await sleep(150);
  }

  throw new Error(`[test-fixtures] profile ${profileId} was not created by auth trigger`);
}

async function createProfile(
  authClient: FixtureSupabaseClient,
  schemaClient: SchemaClient,
  schema: string,
  label: string,
  index: number,
  mode: TestProfileMode,
): Promise<SeededTestProfile> {
  const suffix = crypto.randomBytes(4).toString('hex');
  const handle = `${label}_${index}_${suffix}`.replace(/[^a-z0-9_]/g, '_').slice(0, 30);
  const email = `fixture-${schema}-${handle}@example.com`;
  const { data: userData, error: userError } = await authClient.auth.admin.createUser({
    email,
    password: defaultPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[test-fixtures] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  await waitForProfile(schemaClient, userData.user.id);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await schemaClient
      .from('profiles')
      .update({
        handle,
        display_name: handle,
        mode,
        verified: mode === 'script_verified',
      })
      .eq('id', userData.user.id)
      .select('id,user_id,handle,mode')
      .single();

    if (!error && data) {
      return {
        id: String(data.id),
        userId: String(data.user_id),
        handle: String(data.handle),
        email,
        mode,
      };
    }

    if (error && !isSchemaCacheMiss(error)) {
      throw new Error(`[test-fixtures] profile update failed: ${error.message}`);
    }

    await sleep(150);
  }

  throw new Error(`[test-fixtures] profile ${userData.user.id} could not be updated`);
}

function sessionRowsFor(profile: SeededTestProfile, label: string, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const firstEventAt = new Date(Date.UTC(2026, 0, 1 + index, 12, 0, 0)).toISOString();
    const lastEventAt = new Date(Date.UTC(2026, 0, 1 + index, 12, 10, 0)).toISOString();
    const sessionId = `${label}-${profile.handle}-${index}`;

    return {
      profile_id: profile.id,
      source: index % 2 === 0 ? 'claude' : 'codex',
      model: index % 2 === 0 ? 'claude-3-5-sonnet' : 'gpt-5-codex',
      session_id: sessionId,
      file_sha256: crypto.createHash('sha256').update(sessionId).digest('hex'),
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      input_tokens: 1000 + index,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 1,
      ingestion_mode: profile.mode,
      fingerprint: {},
    };
  });
}

export async function seedTestDatabase(options: SeedTestDatabaseOptions = {}): Promise<SeedTestDatabaseResult> {
  const schema = resolveSchema(options);
  const authClient = createServiceRoleClient();
  const schemaClient = createSchemaServiceRoleClient(schema);
  const label = (options.label ?? `worker_${resolveWorkerIndex(options.workerId)}`)
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 18);
  const profileCount = options.profileCount ?? 2;
  const sessionsPerProfile = options.sessionsPerProfile ?? 1;
  const mode = options.mode ?? 'script_verified';
  const profiles: SeededTestProfile[] = [];

  for (let index = 0; index < profileCount; index += 1) {
    profiles.push(await createProfile(authClient, schemaClient, schema, label, index, mode));
  }

  const sessionRows = profiles.flatMap((profile) => sessionRowsFor(profile, label, sessionsPerProfile));

  if (sessionRows.length > 0) {
    const { error } = await schemaClient
      .from('sessions')
      .insert(sessionRows);

    if (error) {
      throw new Error(`[test-fixtures] session insert failed: ${error.message}`);
    }
  }

  return {
    schema,
    profiles,
    sessionCount: sessionRows.length,
  };
}
