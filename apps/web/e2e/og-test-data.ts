import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

type ProfileRow = {
  id: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[e2e-og] Missing required environment variable: ${name}`);
  }

  return value;
}

function createServiceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
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

export async function seedOGProfile(handle = 'alex'): Promise<void> {
  const serviceClient = createServiceClient();
  let existingProfile: ProfileRow | null = null;
  let existingError: { message: string } | null = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await serviceClient
      .from('profiles')
      .select('id')
      .eq('handle', handle)
      .maybeSingle<ProfileRow>();

    existingProfile = result.data;
    existingError = result.error;

    if (!existingError || !existingError.message.includes('schema cache')) {
      break;
    }

    await delay(500);
  }

  if (existingError) {
    throw new Error(`[e2e-og] Failed to query existing profile: ${existingError.message}`);
  }

  let profileId = existingProfile?.id;

  if (!profileId) {
    const authClient = createClient(
      readRequiredEnv('SUPABASE_URL'),
      readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
    const { data: userData, error: userError } = await authClient.auth.admin.createUser({
      email: `og-${handle}-${randomUUID()}@example.com`,
      password: `Tr-${randomUUID()}!`,
      email_confirm: true,
    });

    if (userError || !userData.user) {
      throw new Error(`[e2e-og] Failed to create auth user: ${userError?.message ?? 'missing user'}`);
    }

    const { data: shellProfile, error: shellError } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('user_id', userData.user.id)
      .maybeSingle<ProfileRow>();

    if (shellError) {
      throw new Error(`[e2e-og] Failed to load profile shell: ${shellError.message}`);
    }

    if (shellProfile) {
      profileId = shellProfile.id;
    } else {
      profileId = randomUUID();
      const { error: insertError } = await serviceClient
        .from('profiles')
        .insert({
          id: profileId,
          user_id: userData.user.id,
          handle: null,
          mode: null,
          verified: false,
        });

      if (insertError) {
        throw new Error(`[e2e-og] Failed to create profile row: ${insertError.message}`);
      }
    }
  }

  const { error: profileError } = await serviceClient
    .from('profiles')
    .update({
      handle,
      display_name: 'Alex Builder',
      avatar_url: `https://api.dicebear.com/9.x/initials/png?seed=${handle}`,
      mode: 'script_verified',
      verified: true,
    })
    .eq('id', profileId);

  if (profileError) {
    if (!profileError.message.includes('profiles_handle_key')) {
      throw new Error(`[e2e-og] Failed to seed profile: ${profileError.message}`);
    }

    const { data: racedProfile, error: racedProfileError } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('handle', handle)
      .single<ProfileRow>();

    if (racedProfileError || !racedProfile) {
      throw new Error(`[e2e-og] Failed to load concurrently seeded profile: ${racedProfileError?.message ?? 'missing profile'}`);
    }

    profileId = racedProfile.id;
  }

  const { error: sessionError } = await serviceClient
    .from('sessions')
    .upsert(
      {
        profile_id: profileId,
        source: 'claude',
        model: 'claude-3-5-sonnet',
        session_id: `og-${handle}-profile-card`,
        file_sha256: 'f'.repeat(64),
        first_event_at: '2026-04-28T10:00:00.000Z',
        last_event_at: '2026-04-28T10:15:00.000Z',
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        turns: 3,
        platform: 'e2e',
        ingestion_mode: 'script_verified',
      },
      {
        onConflict: 'profile_id,source,session_id,file_sha256',
      },
    );

  if (sessionError) {
    throw new Error(`[e2e-og] Failed to seed sessions: ${sessionError.message}`);
  }

  const { error: aggregateError } = await serviceClient
    .from('daily_aggregates')
    .upsert(
      {
        profile_id: profileId,
        date: '2026-04-28',
        source: 'claude',
        model: 'claude-3-5-sonnet',
        total_tokens: 1_500_000,
        total_sessions: 3,
        derived_cost_usd: 4.5,
      },
      {
        onConflict: 'profile_id,date,source,model',
      },
    );

  if (aggregateError) {
    throw new Error(`[e2e-og] Failed to seed aggregates: ${aggregateError.message}`);
  }
}

export async function getPngMetadata(responseBody: Buffer): Promise<{ width: number; height: number }> {
  const pngSignature = '89504e470d0a1a0a';

  if (responseBody.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error('[e2e-og] Response body is not a PNG');
  }

  return {
    width: responseBody.readUInt32BE(16),
    height: responseBody.readUInt32BE(20),
  };
}
