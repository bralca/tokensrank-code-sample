import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { adminClient, createDisposableAnonClient } from '../../clients/supabase';
import { setCookies } from '../../plugins/cookies';

// `repo` grants read access to commits on both public AND private repos' prod
// branches (the user asked to connect all their repos). Narrow to `public_repo`
// if a gentler, public-only consent prompt is preferred.
const GITHUB_SCOPES = 'read:user user:email repo';

const SessionBodySchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  provider_token: z.string().optional(),
}).strict();

function webBaseUrl(): string {
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return process.env.NEXT_PUBLIC_SITE_URL || allowed[0] || 'http://127.0.0.1:3000';
}

function sanitizeHandle(login: string): string | null {
  const handle = login.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);

  return handle.length >= 3 ? handle : null;
}

type ProfileShell = { id: string; user_id: string; handle: string | null; mode: string | null };

/**
 * The on_auth_users_insert trigger creates the profile shell; wait for it, then
 * seed a handle from the GitHub login if one is not set yet.
 */
async function ensureProfileForUser(userId: string, login: string | null): Promise<ProfileShell | null> {
  for (const delay of [0, 100, 200, 400, 800]) {
    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const { data } = await adminClient
      .from('profiles')
      .select('id,user_id,handle,mode')
      .eq('user_id', userId)
      .maybeSingle<ProfileShell>();

    if (data) {
      if (!data.handle && login) {
        const handle = sanitizeHandle(login);
        if (handle) {
          await adminClient
            .from('profiles')
            .update({ handle, mode: data.mode ?? 'self_reported' })
            .eq('id', data.id);
          return { ...data, handle };
        }
      }
      return data;
    }
  }

  // The on_auth_users_insert trigger seeds the shell into the schema named by the
  // auth user's metadata — public for real OAuth logins. When this API runs against
  // a different schema (dev/test), or if the trigger is slow, create the shell here
  // so sign-in still works. Idempotent on the unique user_id; falls back to a
  // handle-less shell if the GitHub login collides with an existing handle.
  const handle = login ? sanitizeHandle(login) : null;
  const candidateRows: Array<Record<string, unknown>> = handle
    ? [{ user_id: userId, handle, mode: 'self_reported' }, { user_id: userId, mode: 'self_reported' }]
    : [{ user_id: userId, mode: 'self_reported' }];

  for (const row of candidateRows) {
    const { data, error } = await adminClient
      .from('profiles')
      .upsert(row, { onConflict: 'user_id' })
      .select('id,user_id,handle,mode')
      .single<ProfileShell>();

    if (!error && data) {
      return data;
    }
  }

  const { data } = await adminClient
    .from('profiles')
    .select('id,user_id,handle,mode')
    .eq('user_id', userId)
    .maybeSingle<ProfileShell>();

  return data ?? null;
}

/**
 * GitHub-OAuth-only auth (Supabase provider). The browser navigates to
 * `/api/auth/github/start`, which 302s to Supabase's authorize endpoint;
 * Supabase returns to the web `/auth/callback` page with the session in the URL
 * hash, and that page POSTs the tokens to `/api/auth/github/session`, which
 * verifies them, persists the github_identity, and sets the tr_at/tr_rt cookies
 * (same session scheme as the email/password flow this replaces).
 */
export async function registerGithubOAuthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/auth/github/start', async (_req: FastifyRequest, reply: FastifyReply) => {
    const supabaseUrl = process.env.SUPABASE_URL ?? '';
    const redirectTo = `${webBaseUrl()}/auth/callback`;
    const authorizeUrl = `${supabaseUrl}/auth/v1/authorize?provider=github`
      + `&redirect_to=${encodeURIComponent(redirectTo)}`
      + `&scopes=${encodeURIComponent(GITHUB_SCOPES)}`;

    return reply.code(302).header('Location', authorizeUrl).send();
  });

  fastify.post<{ Body: unknown }>('/api/auth/github/session', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = SessionBodySchema.safeParse(req.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_session', message: 'Missing session tokens' } });
    }

    const { access_token: accessToken, refresh_token: refreshToken, provider_token: providerToken } = parsed.data;

    const anon = createDisposableAnonClient();
    const { data: userData, error } = await anon.auth.getUser(accessToken);

    if (error || !userData.user) {
      return reply.code(401).send({ error: { code: 'invalid_session', message: 'Could not verify session' } });
    }

    const user = userData.user;
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const githubUserId = Number(meta.provider_id ?? meta.sub ?? 0);
    const login = typeof meta.user_name === 'string'
      ? meta.user_name
      : typeof meta.preferred_username === 'string'
        ? meta.preferred_username
        : null;
    const verifiedEmails = [user.email].filter((value): value is string => typeof value === 'string');

    const profile = await ensureProfileForUser(user.id, login);

    if (!profile) {
      return reply.code(500).send({ error: { code: 'no_profile', message: 'Profile was not created' } });
    }

    if (Number.isFinite(githubUserId) && githubUserId > 0 && login) {
      const { error: identityError } = await adminClient
        .from('github_identities')
        .upsert({
          profile_id: profile.id,
          github_user_id: githubUserId,
          login,
          verified_emails: verifiedEmails,
          provider_token: providerToken ?? null,
          followers: typeof meta.followers === 'number' ? meta.followers : 0,
          updated_at: new Date().toISOString(),
        // Conflict on github_user_id (the GitHub account), not profile_id: one
        // GitHub account = one identity, re-pointed to the current profile. This
        // lets a re-login re-attach the identity if the profile id changed.
        }, { onConflict: 'github_user_id' });

      if (identityError) {
        req.log.warn({ event: 'github.identity_upsert_failed', error: identityError.message }, 'GitHub identity upsert failed');
      }
      // Use the verified immutable GitHub identity; preserve a custom profile photo.
      await adminClient.from('profiles')
        .update({ avatar_url: `https://avatars.githubusercontent.com/u/${githubUserId}?s=192` })
        .eq('id', profile.id).is('avatar_url', null);
    }

    setCookies(reply, { accessToken, refreshToken });

    return reply.code(200).send({
      data: { user_id: user.id, profile_id: profile.id, handle: profile.handle ?? login },
    });
  });
}
