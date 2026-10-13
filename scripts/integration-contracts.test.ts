import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('integration wiring contracts IC-1 through IC-12', () => {
  it('IC-1: auth routes use disposable anon clients for Supabase Auth calls', () => {
    const authRoutes = [
      source('apps/api/src/routes/auth.routes.ts'),
      source('apps/api/src/routes/auth/sign-up.ts'),
      source('apps/api/src/routes/auth/password-reset-request.ts'),
    ].join('\n');

    expect(authRoutes).toContain('createDisposableAnonClient');
    expect(authRoutes).toContain('anon.auth.signInWithPassword');
    expect(authRoutes).toContain('anon.auth.signUp');
    expect(authRoutes).toContain('anon.auth.refreshSession');
    expect(authRoutes).toContain('anon.auth.verifyOtp');
    expect(authRoutes).toContain('anon.auth.resetPasswordForEmail');
  });

  it('IC-2 and IC-3: ingestion routes validate schema/bounds before safe session insert', () => {
    const ingestionRoutes = [
      source('apps/api/src/routes/script-sessions.ts'),
      source('apps/api/src/routes/self-reported/sessions.ts'),
    ].join('\n');
    const ingestionService = source('apps/api/src/services/ingestion.ts');

    expect(ingestionRoutes).toContain('preHandler: fastify.requireAccessKey');
    expect(ingestionRoutes).toContain('handleIngest');
    expect(ingestionService).toContain('IngestRequestSchema.safeParse');
    expect(ingestionService).toContain('MAX_TOTAL_TOKENS');
    expect(ingestionService).toContain("reason_code: 'bounds_violation'");
    expect(ingestionService).toContain('GitHub-corroborated ranking score');
    expect(ingestionService).toContain('ignoreDuplicates: true');
    expect(ingestionService).toContain("onConflict: 'profile_id,source,session_id,file_sha256'");
    expect(ingestionService).not.toMatch(/\.from\(['"]daily_aggregates['"]\)\s*\.\s*(insert|upsert)/);
  });

  it('IC-4: script ingestion escalates mode once and invalidates caches on accepted rows', () => {
    const ingestionService = source('apps/api/src/services/ingestion.ts');

    expect(ingestionService).toContain("scope !== 'script' || acceptedCount === 0 || auth.mode === 'script_verified'");
    expect(ingestionService).toContain("escalateProfileMode(this.supabaseClient, auth.profileId, 'script_verified')");
    expect(ingestionService).toContain('this.invalidateCache()');
    expect(ingestionService).toContain("event_type: 'profile.mode_escalation'");
  });

  it('IC-5 and IC-6: cache reads use versioned LRU keys and admin purge uses constant-time bearer auth', () => {
    const cacheSource = source('apps/api/src/services/cache.ts');
    const leaderboardRoute = source('apps/api/src/routes/leaderboard.ts');
    const adminAuth = source('apps/api/src/plugins/auth.ts');
    const cachePurge = source('apps/api/src/routes/admin/cache-purge.ts');

    expect(cacheSource).toContain('new LRUCache');
    expect(cacheSource).toContain('cacheVersion');
    expect(cacheSource).toContain('buildVersionedCacheKey');
    expect(leaderboardRoute).toContain('withCache');
    expect(leaderboardRoute).toContain('buildLeaderboardCacheKey');
    expect(adminAuth).toContain('crypto.timingSafeEqual');
    expect(cachePurge).toContain('preHandler: [fastify.requireAdmin]');
    expect(cachePurge).toContain('bumpCacheVersion');
    expect(cachePurge).toContain('purgeKeys');
    expect(cachePurge).toContain('purgeByPrefix');
  });

  it('IC-7: badge evaluator is idempotent and gates verification-only badges', () => {
    const badgeEvaluator = source('apps/api/src/services/badge-evaluator.ts');

    expect(badgeEvaluator).toContain('requires_verification === true && profile.mode !== \'script_verified\'');
    expect(badgeEvaluator).toContain('ON CONFLICT DO NOTHING');
    expect(badgeEvaluator).not.toMatch(/DELETE\s+FROM\s+.*profile_badges/i);
  });

  it('IC-8: frontend API helpers use Fastify fetch contracts, not direct Supabase data reads', () => {
    const apiHelper = source('apps/web/app/lib/api/index.ts');
    const serverApiHelper = source('apps/web/app/lib/api-server.ts');

    expect(apiHelper).toContain('fetch(buildApiUrl(path)');
    expect(serverApiHelper).toContain('fetch(buildApiUrl(path)');
    expect(apiHelper).not.toContain('@supabase/supabase-js');
    expect(serverApiHelper).not.toContain('@supabase/supabase-js');
    expect(serverApiHelper).toContain('revalidateTag');
  });

  it('IC-9: script/self-reported access keys are bearer-scoped by endpoint', () => {
    const bearerAuth = source('apps/api/src/plugins/bearer-auth.ts');

    expect(bearerAuth).toContain('^tr_(script|self_reported)_[A-Za-z0-9_-]{32}$');
    expect(bearerAuth).toContain("if (path === '/api/script/sessions')");
    expect(bearerAuth).toContain("return 'script'");
    expect(bearerAuth).toContain("if (path === '/api/self-reported/sessions')");
    expect(bearerAuth).toContain("return 'self_reported'");
    expect(bearerAuth).toContain('wrongKeyScope');
    expect(bearerAuth).toContain('crypto.timingSafeEqual');
  });

  it('IC-10: sessions trigger aggregates statement-level batches before upsert conflicts', () => {
    const initialSchema = source('supabase/migrations/0001_initial_schema.sql');

    expect(initialSchema).toContain('REFERENCING NEW TABLE AS new_sessions');
    expect(initialSchema).toContain('FOR EACH STATEMENT EXECUTE FUNCTION public.upsert_daily_aggregates_on_sessions_insert()');
    expect(initialSchema).toContain('GROUP BY profile_id');
    expect(initialSchema).toContain('ON CONFLICT (profile_id, date, source, model)');
    expect(initialSchema).toContain('REFERENCES public.profiles(id)');
  });

  it('IC-11: test worker schemas are selected dynamically and sent as PostgREST profiles', () => {
    const supabaseClient = source('apps/api/src/clients/supabase.ts');
    const integrationSetup = source('apps/api/test/integration/per-worker-setup.ts');
    const setupHelpers = source('apps/api/test/integration/setup.ts');
    const supabaseConfig = source('supabase/config.toml');

    expect(supabaseClient).toContain('process.env.SUPABASE_SCHEMA');
    expect(supabaseClient).toContain('"Accept-Profile": schema');
    expect(supabaseClient).toContain('"Content-Profile": schema');
    expect(integrationSetup).toContain('setupTestSchema(schema)');
    expect(setupHelpers).toContain('reset_test_schema');
    expect(supabaseConfig).toContain('tokensrank_test_w0');
    expect(supabaseConfig).toContain('tokensrank_test_w3');
  });

  it('IC-12: OG route renders exact PNG dimensions with timeout font fallback and ETag caching', () => {
    const ogRoute = source('apps/web/app/og/u/[handle].png/route.ts');
    const ogFonts = source('apps/web/lib/og-fonts.ts');

    expect(ogRoute).toContain('const IMAGE_WIDTH = 1200');
    expect(ogRoute).toContain('const IMAGE_HEIGHT = 630');
    expect(ogRoute).toContain("new ImageResponse(jsx,");
    expect(ogRoute).toContain('loadGeistFont(OG_FONT_TIMEOUT_MS)');
    expect(ogRoute).toContain('ETag: etag');
    expect(ogRoute).toContain('status: 304');
    expect(ogFonts).toContain('timeoutMs = 2000');
    expect(ogFonts).toContain('controller.abort()');
  });
});
