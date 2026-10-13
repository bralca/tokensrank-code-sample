# Performance Test Baseline

Task 94.1 scan results for performance and state-lifecycle acceptance work.

## Test Framework Locations

- Root Vitest unit config: `vitest.config.ts`
- API integration Vitest config: `apps/api/vitest.integration.config.ts`
- Web component Vitest config: `apps/web/vitest.config.ts`
- Web Playwright E2E config: `apps/web/playwright.config.ts`
- Script Vitest config: `packages/script/vitest.config.ts`
- Script POSIX tests: `packages/script/test/*.bats`
- Script Windows tests: `packages/script/test/*.Tests.ps1` and `packages/script/src/runtime/*.Tests.ps1`

## Existing Performance-Adjacent Tests

- API cache and leaderboard timing/behavior: `apps/api/test/integration/leaderboard-cache.test.ts`, `apps/api/test/integration/profile-cache.test.ts`, `apps/api/test/integration/cache-observability.spec.ts`
- API ingestion and fraud path coverage: `apps/api/test/integration/script-sessions-task46.spec.ts`, `apps/api/test/integration/fraud-gates.spec.ts`, `apps/api/test/integration/mode-and-dedup.spec.ts`
- API MV/reconcile timing: `apps/api/test/integration/perf-mv-reconcile.spec.ts`
- Web OG and profile E2E coverage: `apps/web/e2e/og-cards.spec.ts`, `apps/web/e2e/og-visual-regression.spec.ts`, `apps/web/e2e/profile.spec.ts`
- Script runtime/state coverage: `packages/script/test/runner.bats`, `packages/script/test/file-lock.bats`, `packages/script/test/offline-queue.bats`, `packages/script/test/idempotency*.bats`, `packages/script/test/*Tests.ps1`

## Fixtures And Helpers

- Shared real-Supabase fixture package: `packages/test-fixtures/src/index.ts`
- API integration setup and schema isolation: `apps/api/test/integration/per-worker-setup.ts`, `apps/api/test/integration/setup.ts`
- API ingestion fixture helpers: `apps/api/test/integration/ingestion-test-helpers.ts`
- API 100-session fixture data: `apps/api/test/fixtures/ingestion-100-mixed.json`
- Web E2E seed helpers: `apps/web/e2e/fixtures/seed-data.ts`, `apps/web/e2e/fixtures/global-setup.ts`, `apps/web/e2e/fixtures/global-teardown.ts`
- Script privacy/parser fixtures: `packages/script/test/fixtures/**`

## Ports And Isolation

- API default acceptance port: `3001`; current Playwright default API port is `4001` unless `PLAYWRIGHT_API_PORT` is set.
- Web default acceptance port: `3000`.
- Supabase remote dev is used through exposed worker schemas `tokensrank_test_w0` through `tokensrank_test_w3`.
- API integration tests should run with `NODE_ENV=test` and `SUPABASE_SCHEMA` set by per-worker setup or explicitly for targeted runs.
