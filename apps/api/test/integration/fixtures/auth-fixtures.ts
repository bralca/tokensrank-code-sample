import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { parse as parseCookie } from 'cookie';

import {
  createDisposableAnonClient,
  createServiceRoleClient,
  resolveTestSchema,
} from '../setup';

type ProfileMode = 'script_verified' | 'self_reported' | null;
type SessionSource = 'claude' | 'codex';
type SessionMode = 'script_verified' | 'self_reported';

export type TestUser = {
  accessToken: string;
  cookieHeader: string;
  email: string;
  handle: string;
  password: string;
  profileId: string;
  refreshToken: string;
  userId: string;
};

export type TestSession = {
  file_sha256: string;
  id: string;
  input_tokens: number;
  model: string;
  output_tokens: number;
  session_id: string;
  source: SessionSource;
};

export type AuthCookieSet = {
  access: {
    header?: string;
    value: string;
  };
  cookieHeader: string;
  refresh: {
    header?: string;
    value: string;
  };
};

type CreateTestUserOptions = {
  emailDomain?: string;
  handle?: string;
  label?: string;
  mode?: ProfileMode;
  password?: string;
};

type CreateTestSessionsOptions = {
  count?: number;
  ingestionMode?: SessionMode;
  label?: string;
  model?: string;
  source?: SessionSource;
  tokensPerSession?: number;
};

const defaultPassword = 'Correct-horse-battery-staple-QC6!';

function activeSchema(): string {
  return process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[auth-fixtures] Missing required environment variable: ${name}`);
  }

  return value;
}

function schemaClient() {
  const schema = activeSchema();

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

function uniqueSuffix(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function safeSegment(value: string, maxLength: number): string {
  return value.replace(/[^a-z0-9.-]/g, '-').slice(0, maxLength);
}

function safeHandleSegment(value: string, maxLength: number): string {
  return value.replace(/[^a-z0-9_]/g, '_').slice(0, maxLength);
}

function uniqueEmail(label: string, domain: string): string {
  return [
    'qc6',
    safeSegment(activeSchema(), 28),
    safeSegment(label, 14),
    uniqueSuffix(),
  ].join('-') + `@${domain}`;
}

function uniqueHandle(label: string): string {
  return `qc6_${safeHandleSegment(label, 10)}_${crypto.randomUUID().slice(0, 8)}`.slice(0, 30);
}

function cookiePair(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`;
}

function cookieHeadersFrom(source: readonly string[] | string | undefined): string[] {
  if (!source) {
    return [];
  }

  return Array.isArray(source) ? [...source] : [source];
}

function cookieValueFromHeader(header: string, name: string): string {
  const [pair = ''] = header.split(';');
  const [rawName, ...rawValue] = pair.split('=');

  if (rawName !== name) {
    return '';
  }

  return decodeURIComponent(rawValue.join('='));
}

function hasCookieAttribute(header: string, attribute: string): boolean {
  return header
    .split(';')
    .map((part) => part.trim().toLowerCase())
    .includes(attribute.toLowerCase());
}

function findSetCookie(headers: readonly string[], name: 'tr_at' | 'tr_rt'): string {
  const header = headers.find((value) => value.startsWith(`${name}=`));

  if (!header) {
    throw new Error(`[auth-fixtures] Missing Set-Cookie header for ${name}`);
  }

  return header;
}

async function waitForProfile(userId: string) {
  const admin = schemaClient();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await admin
      .from('profiles')
      .select('id,user_id,handle,mode')
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data) {
      return data as {
        handle: string | null;
        id: string;
        mode: ProfileMode;
        user_id: string;
      };
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  throw new Error(`[auth-fixtures] Profile shell was not created for user ${userId}`);
}

export function getAuthCookies(source: TestUser | readonly string[] | string | undefined): AuthCookieSet {
  if (typeof source === 'object' && source !== null && 'accessToken' in source) {
    return {
      access: {
        value: source.accessToken,
      },
      cookieHeader: [
        cookiePair('tr_at', source.accessToken),
        cookiePair('tr_rt', source.refreshToken),
      ].join('; '),
      refresh: {
        value: source.refreshToken,
      },
    };
  }

  const headers = cookieHeadersFrom(source);
  const accessHeader = findSetCookie(headers, 'tr_at');
  const refreshHeader = findSetCookie(headers, 'tr_rt');
  const accessCookie = parseCookie(accessHeader);
  const refreshCookie = parseCookie(refreshHeader);

  if (
    accessCookie['Max-Age'] !== '3600'
    || accessCookie.Path !== '/'
    || accessCookie.SameSite !== 'Lax'
    || !hasCookieAttribute(accessHeader, 'HttpOnly')
    || !hasCookieAttribute(accessHeader, 'Secure')
  ) {
    throw new Error('[auth-fixtures] tr_at Set-Cookie header does not match required auth flags');
  }

  if (
    refreshCookie['Max-Age'] !== '2592000'
    || refreshCookie.Path !== '/api/auth/refresh'
    || refreshCookie.SameSite !== 'Lax'
    || !hasCookieAttribute(refreshHeader, 'HttpOnly')
    || !hasCookieAttribute(refreshHeader, 'Secure')
  ) {
    throw new Error('[auth-fixtures] tr_rt Set-Cookie header does not match required auth flags');
  }

  const accessValue = cookieValueFromHeader(accessHeader, 'tr_at');
  const refreshValue = cookieValueFromHeader(refreshHeader, 'tr_rt');

  return {
    access: {
      header: accessHeader,
      value: accessValue,
    },
    cookieHeader: [
      cookiePair('tr_at', accessValue),
      cookiePair('tr_rt', refreshValue),
    ].join('; '),
    refresh: {
      header: refreshHeader,
      value: refreshValue,
    },
  };
}

export async function createTestUser(options: CreateTestUserOptions = {}): Promise<TestUser> {
  const schema = activeSchema();
  const authAdmin = createServiceRoleClient();
  const admin = schemaClient();
  const anon = createDisposableAnonClient(schema);
  const label = options.label ?? 'user';
  const password = options.password ?? defaultPassword;
  const email = options.handle
    ? uniqueEmail(options.handle, options.emailDomain ?? 'example.com')
    : uniqueEmail(label, options.emailDomain ?? 'example.com');
  const handle = options.handle ?? uniqueHandle(label);

  const { data: userData, error: createError } = await authAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (createError || !userData.user) {
    throw new Error(`[auth-fixtures] createUser failed: ${createError?.message ?? 'missing user'}`);
  }

  const profile = await waitForProfile(userData.user.id);
  const { data: updatedProfile, error: updateError } = await admin
    .from('profiles')
    .update({
      handle,
      mode: options.mode ?? 'self_reported',
      verified: options.mode === 'script_verified',
    })
    .eq('id', profile.id)
    .select('id,handle')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[auth-fixtures] Profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: sessionData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !sessionData.session) {
    throw new Error(`[auth-fixtures] signIn failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: sessionData.session.access_token,
    cookieHeader: [
      cookiePair('tr_at', sessionData.session.access_token),
      cookiePair('tr_rt', sessionData.session.refresh_token),
    ].join('; '),
    email,
    handle: updatedProfile.handle,
    password,
    profileId: updatedProfile.id,
    refreshToken: sessionData.session.refresh_token,
    userId: userData.user.id,
  };
}

export async function createTestSessions(
  profileId: string,
  options: CreateTestSessionsOptions = {},
): Promise<TestSession[]> {
  const admin = schemaClient();
  const count = options.count ?? 2;
  const label = safeHandleSegment(options.label ?? 'session', 18);
  const source = options.source ?? 'claude';
  const model = options.model ?? 'claude-3-5-sonnet-20241022';
  const ingestionMode = options.ingestionMode ?? 'script_verified';
  const tokensPerSession = options.tokensPerSession ?? 12_500;
  const baseMs = Date.now() - (6 * 60 * 60 * 1000);

  const rows = Array.from({ length: count }, (_, index) => {
    const firstEventAt = new Date(baseMs + (index * 10 * 60 * 1000)).toISOString();
    const lastEventAt = new Date(baseMs + (index * 10 * 60 * 1000) + (4 * 60 * 1000)).toISOString();
    const sessionId = `qc6-${label}-${crypto.randomUUID().slice(0, 10)}-${index}`;
    const outputTokens = Math.max(1_000, Math.floor(tokensPerSession * 0.2));
    const cacheReadTokens = Math.max(0, Math.floor(tokensPerSession * 0.05));
    const inputTokens = tokensPerSession - outputTokens - cacheReadTokens;

    return {
      cache_create_tokens: 0,
      cache_read_tokens: cacheReadTokens,
      cached_tokens: 0,
      file_sha256: crypto.createHash('sha256').update(sessionId).digest('hex'),
      first_event_at: firstEventAt,
      ingestion_mode: ingestionMode,
      input_tokens: inputTokens,
      last_event_at: lastEventAt,
      model,
      output_tokens: outputTokens,
      platform: 'darwin',
      profile_id: profileId,
      reasoning_tokens: 0,
      session_id: sessionId,
      source,
      turns: 3,
    };
  });

  const { data, error } = await admin
    .from('sessions')
    .insert(rows)
    .select('id,session_id,file_sha256,source,model,input_tokens,output_tokens');

  if (error || !data) {
    throw new Error(`[auth-fixtures] Session insert failed: ${error?.message ?? 'missing rows'}`);
  }

  const aggregateTotals = rows.reduce<Record<string, {
    date: string;
    model: string;
    source: SessionSource;
    totalSessions: number;
    totalTokens: number;
  }>>((totals, row) => {
    const key = `${row.last_event_at.slice(0, 10)}:${row.source}:${row.model}`;
    const totalTokens = row.input_tokens
      + row.output_tokens
      + row.cache_read_tokens
      + row.cache_create_tokens
      + row.cached_tokens
      + row.reasoning_tokens;
    const current = totals[key] ?? {
      date: row.last_event_at.slice(0, 10),
      model: row.model,
      source: row.source,
      totalSessions: 0,
      totalTokens: 0,
    };

    current.totalSessions += 1;
    current.totalTokens += totalTokens;
    totals[key] = current;

    return totals;
  }, {});

  const aggregateRows = Object.values(aggregateTotals).map((aggregate) => ({
    date: aggregate.date,
    derived_cost_usd: aggregate.totalTokens * 0.00001,
    model: aggregate.model,
    profile_id: profileId,
    source: aggregate.source,
    total_sessions: aggregate.totalSessions,
    total_tokens: aggregate.totalTokens,
  }));

  if (aggregateRows.length > 0) {
    const { error: aggregateError } = await admin
      .from('daily_aggregates')
      .upsert(aggregateRows);

    if (aggregateError) {
      throw new Error(`[auth-fixtures] Aggregate seed failed: ${aggregateError.message}`);
    }
  }

  return data as TestSession[];
}

export async function deleteTestUsers(userIds: Iterable<string>): Promise<void> {
  const authAdmin = createServiceRoleClient();

  for (const userId of userIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
}
