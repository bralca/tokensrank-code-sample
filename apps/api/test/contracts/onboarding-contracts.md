# Onboarding Contracts Verification

Task 74.0 verifies the explicit contract set listed for onboarding and script offline queue wiring. The task text says "all 8 contracts" but enumerates nine IDs; this checklist covers the full enumerated set.

| Contract | Status | Verification |
| --- | --- | --- |
| IC-1 Auth route -> Supabase client | ✓ | `apps/api/src/routes/onboarding.ts` uses `requireAuth()` and request-scoped auth context for `/api/me/onboarding` and `/api/onboarding/waiting`; `apps/api/test/integration/onboarding-sse.test.ts` verifies unauthenticated SSE returns `401`. |
| IC-2 Ingestion route -> Fraud validation | ✓ | Existing ingestion route remains the only script POST target; onboarding E2E triggers POST through `/api/ingest` and does not add a bypass path. |
| IC-3 Fraud validation -> Database INSERT | ✓ | Onboarding status endpoint is read-only; SSE polls `ingestion_runs` and never writes generated session columns or daily aggregate rows. |
| IC-4 Mode escalation logic -> Profile UPDATE | ✓ | `packages/script/bin/agent.mjs` drains pending payloads before extracting new sessions, preserves queued payloads on `401`, and script POST success continues to use the existing ingestion escalation path. |
| IC-5 Cache service -> LRU instance | ✓ | `GET /api/me/onboarding` caches via `withCache()` with versioned key `onboarding:v1:${userId}` and a 300-second TTL. |
| IC-6 Cache admin purge -> Cache module | ✓ | `POST /api/me/onboarding` purges onboarding and `/api/me` cache keys after mode changes; admin purge security behavior is unchanged by this task. |
| IC-8 Frontend -> Backend API | ✓ | Onboarding UI uses backend HTTP routes only (`/api/me/onboarding`, `/api/onboarding/waiting`, `/api/me`) and shared Zod-derived response types. |
| P-1 Strict Zod boundary validation | ✓ | Shared onboarding schemas are strict; `POST /api/me/onboarding` validates the request body with `OnboardingModeRequestSchema.safeParse()`. |
| SM-2 Session & Data Ingestion State | ✓ | `packages/script/src/state.ts` implements FIFO `pending_payloads` with 24-cap eviction, 3 retry attempts for 5xx/network failures, success drain on 2xx, and stop-on-401 behavior; covered by Vitest and Bats tests. |

Verification commands run during Task 74.0:

- `pnpm --filter @tokensrank/shared typecheck`
- `pnpm --filter @tokensrank/api run type-check`
- `pnpm --filter @tokensrank/web run type-check`
- `pnpm --filter @tokensrank/script run type-check`
- `NODE_ENV=test pnpm --filter @tokensrank/api exec vitest run --config vitest.integration.config.ts test/integration/onboarding.spec.ts`
- `NODE_ENV=test pnpm --filter @tokensrank/api exec vitest run --config vitest.integration.config.ts test/integration/offline-queue.test.ts`
- `NODE_ENV=test pnpm --filter @tokensrank/api exec vitest run --config vitest.integration.config.ts test/integration/onboarding-sse.test.ts`
- `pnpm --filter @tokensrank/script exec vitest run src/runtime/__tests__/state-management.test.ts src/runtime/__tests__/state-flow.integration.test.ts src/state.test.ts`
- `pnpm --filter @tokensrank/script exec bats test/atomic-write-integration.bats`
- `pnpm --filter @tokensrank/script exec bats test/offline-queue.bats`
- `pnpm --filter @tokensrank/web exec playwright test e2e/onboarding-mode-a.spec.ts --project=chromium --workers=1`
- `pnpm --filter @tokensrank/web exec playwright test e2e/onboarding-mode-b.spec.ts --project=chromium --workers=1`

CI matrix note: local verification covers Chromium, Vitest integration, script Vitest, and Bats in this worktree. The repository CI must run the configured ubuntu-latest, macos-latest, and windows-latest jobs after this commit is pushed.
