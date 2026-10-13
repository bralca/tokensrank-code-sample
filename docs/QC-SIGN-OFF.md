# TokensRank Feature Integration QC Sign-Off

Date: 2026-04-29
Branch: `feat/feature-21e0d0a8`
Task: `FEATURE-QC`

## Result

Feature Integration QC is functionally approved by the local evidence collected in this worktree. All test commands listed below exited 0. The full API integration suite passed but measured 504 seconds, so runtime tuning remains an optimization note rather than a hidden result.

## Test Evidence

| Gate | Result |
| --- | --- |
| Prerequisites | Node v22.14.0, pnpm 10.27.0, dependencies, env, Supabase, test schemas, and Playwright available |
| Typecheck | `pnpm typecheck` passed |
| Build | `NODE_ENV=production pnpm build` passed |
| Unit | `pnpm -r run test:unit`: 725 passed, 0 failed, 0 skipped |
| DB reset | `pnpm test:db:reset` passed; 8 tables, 16 badges, 8 RLS-enabled tables, 7 triggers verified |
| API integration | `NODE_ENV=test pnpm --filter @tokensrank/api test:integration`: 557 passed, 0 failed, 0 skipped |
| E2E default | `pnpm --filter @tokensrank/web test:e2e`: 54 passed, 0 failed, 0 skipped |
| E2E acceptance | Playwright acceptance regressions: 74 passed, 0 failed, 0 skipped |
| Script Bats | 90 passed, 0 failed, 8 Linux-only systemd skips |
| Script Pester | 43 passed, 0 failed, 1 platform skip |
| Privacy | Static and runtime privacy gates passed |
| Deployment | 16 deployment/static tests, Caddy validation, PM2 syntax, rollback syntax, and deployment smoke passed |

## Checkpoints

### Prerequisites

- [x] PASS Node version satisfies repo engine requirements.
- [x] PASS pnpm version satisfies repo engine requirements.
- [x] PASS `pnpm install --frozen-lockfile` completed with the lockfile in sync.
- [x] PASS Root `.env` resolves in the feature worktree.
- [x] PASS Required Supabase URL and key variables are present.
- [x] PASS Supabase REST endpoint is reachable.
- [x] PASS Test worker schemas can be reset.
- [x] PASS Playwright package is installed.
- [x] PASS Playwright Chromium is installed.
- [x] PASS Caddy is installed for local artifact validation.

### Build And Type Safety

- [x] PASS Root typecheck completed.
- [x] PASS API TypeScript build completed.
- [x] PASS Web Next.js production build completed.
- [x] PASS Shared package build completed.
- [x] PASS Script package artifact check completed.
- [x] PASS API `dist` server artifact exists.
- [x] PASS Shared `dist/index.js` exists.
- [x] PASS Web `.next/BUILD_ID` exists.
- [x] PASS Script `bin/agent.mjs` exists.
- [x] PASS POSIX installer remains executable.
- [x] PASS Next sitemap no longer fetches API data during production build.
- [x] PASS Next ESLint config is installed and lint-compatible.

### Unit Tests

- [x] PASS Shared unit suite passed.
- [x] PASS Script unit suite passed.
- [x] PASS Web unit suite passed.
- [x] PASS API unit suite passed.
- [x] PASS Fraud service unit chain fakes match production query chains.
- [x] PASS Ingestion unit fakes cover ratchet and audit array inserts.
- [x] PASS OG font cache unit tests cover cloned ArrayBuffers.
- [x] PASS Custom avatar lint rule unit test is isolated from unrelated accessibility linting.
- [x] PASS Sign-up route unit tests use deliverable-looking test email domains.
- [x] PASS Full unit aggregate is 725 passed, 0 failed, 0 skipped.

### Database

- [x] PASS Root `test:db:reset` command exists.
- [x] PASS Test schema reset runs sequentially for worker schemas.
- [x] PASS Retry delays are bounded for schema reset.
- [x] PASS Reset leaves 8 production tables visible.
- [x] PASS Reset seeds exactly 16 design-canon badges.
- [x] PASS Public badge seed count is 16.
- [x] PASS RLS is enabled on all 8 production tables.
- [x] PASS Session insert trigger exists.
- [x] PASS Updated-at triggers exist on mutable tables.
- [x] PASS Migration sanity checks ran in API integration.

### API Integration

- [x] PASS Full API integration suite exited 0.
- [x] PASS Fraud gates reject future timestamps.
- [x] PASS Fraud gates reject ratchet violations.
- [x] PASS Fraud drift warnings are recorded as expected negative-path audit events.
- [x] PASS Batch size limit accepts 100 sessions.
- [x] PASS Batch size limit rejects oversized payloads.
- [x] PASS Deduplication returns deduped counts without duplicate session rows.
- [x] PASS Partial ingestion status is persisted.
- [x] PASS Mode escalation from self-reported to script-verified is one-way.
- [x] PASS Existing self-reported sessions are not retroactively retagged.
- [x] PASS Daily aggregate trigger creates derived rows.
- [x] PASS RLS owner/public/service-role matrix is enforced.
- [x] PASS Access-key scope enforcement rejects wrong endpoint usage.
- [x] PASS Revoked keys stop ingestion.
- [x] PASS Auth cookies have expected hardened attributes.
- [x] PASS Password reset request remains anti-enumerating.
- [x] PASS Password reset confirm updates password and revokes old sessions.
- [x] PASS Leaderboard cache miss/hit/TTL/purge behavior is covered.
- [x] PASS Profile cache windows are separated.
- [x] PASS Admin cache purge uses bearer auth.
- [x] PASS Badge seed and evaluator contracts are covered.
- [x] PASS Cron jobs use advisory locks.
- [x] PASS `/health` and `/healthz` contracts pass.
- [x] PASS Caddy validation smoke ran inside setup-smoke.
- [x] PASS API integration result is 557 passed, 0 failed, 0 skipped.

### E2E And Acceptance Flow

- [x] PASS Default Playwright package command exited 0.
- [x] PASS SEO/OG default E2E produced 54 passed, 0 failed, 0 skipped.
- [x] PASS Homepage semantic H1 and four-column table are verified.
- [x] PASS Homepage accessibility has zero axe violations in the regression.
- [x] PASS Keyboard tab navigation reaches search and filters.
- [x] PASS Slash keyboard shortcut focuses search.
- [x] PASS Sitemap returns valid XML.
- [x] PASS Robots references sitemap.
- [x] PASS Homepage visual regression matches dark design reference.
- [x] PASS Profile visual regression renders the 10-section structure.
- [x] PASS OG image is 1200x630.
- [x] PASS OG ETag returns 304.
- [x] PASS Cached OG latency stays under 200 ms.
- [x] PASS Acceptance password reset flow passed.
- [x] PASS Acceptance sign-in dashboard flow passed.
- [x] PASS Acceptance access-key revoke UI flow passed.
- [x] PASS Acceptance sign-out flow passed.
- [x] PASS Acceptance script signup flow passed.
- [x] PASS Script onboarding creates and exposes a script access key once.
- [x] PASS Script ingestion posts sessions and escalates mode.
- [x] PASS Script duplicate ingest dedupes.
- [x] PASS Script future timestamp is rejected by fraud gate.
- [x] PASS Script profile appears with stats.
- [x] PASS Script leaderboard includes the new user after refresh path.
- [x] PASS Script OG cards and admin purge path pass.
- [x] PASS Self-reported signup flow passed.
- [x] PASS Self-reported manual ingestion endpoint passed.
- [x] PASS Self-reported avatar wave glyph path passed.
- [x] PASS Client-owned mode and wrong key scope are rejected.
- [x] PASS Four acceptance regressions produced 74 passed, 0 failed, 0 skipped.

### Script, Scheduler, And Privacy

- [x] PASS POSIX Bats suite exited 0.
- [x] PASS POSIX install idempotency is verified.
- [x] PASS POSIX config mode 0600 is verified.
- [x] PASS POSIX UUID install_id is verified.
- [x] PASS POSIX lock acquisition and release are verified.
- [x] PASS POSIX stale lock recovery is verified.
- [x] PASS POSIX offline queue is verified.
- [x] PASS POSIX FIFO queue cap is verified.
- [x] PASS POSIX dry-run output is valid.
- [x] PASS POSIX scheduler launchd template is verified.
- [x] PASS POSIX systemd template assertions are present and skipped only on non-Linux macOS host.
- [x] PASS Pester suite exited 0.
- [x] PASS Windows install idempotency is verified.
- [x] PASS Windows scheduler Task Scheduler XML is verified.
- [x] PASS Windows Mutex behavior is verified.
- [x] PASS Script performance Pester test passed.
- [x] PASS Static privacy scanner reports clean.
- [x] PASS Forbidden-keys Bats test reports clean.
- [x] PASS Runtime privacy extraction test passed.
- [x] PASS Installer-runner POST coherence test passed.

### Deployment

- [x] PASS `Caddyfile` validates with local Caddy.
- [x] PASS `ecosystem.config.cjs` parses under Node.
- [x] PASS PM2 process names are pinned.
- [x] PASS PM2 web command uses `next start`.
- [x] PASS PM2 API command uses built `dist/index.js`.
- [x] PASS `.env.production.example` parses into API and web blocks.
- [x] PASS Production web env does not expose service-role secrets.
- [x] PASS `scripts/rollback.sh` passes shell syntax validation.
- [x] PASS Deployment runbook includes health-check and rollback steps.
- [x] PASS CI workflow has lint, typecheck, build, privacy, unit, integration, performance, E2E, and script lanes.
- [x] PASS CI workflow runs deployment smoke E2E.
- [x] PASS CI workflow includes POSIX, macOS, and Windows script test targets.
- [x] PASS Deployment smoke verifies `/healthz`.
- [x] PASS Deployment smoke verifies leaderboard cache.
- [x] PASS Deployment smoke verifies admin cache purge.
- [x] PASS Deployment smoke result is 1 passed, 0 failed, 0 skipped.

### Logs And Observability

- [x] PASS API logs include request IDs on request completion.
- [x] PASS API logs include ingestion completion summaries.
- [x] PASS Audit logs are recorded for auth and fraud events.
- [x] PASS Intentional warning logs are tied to negative-path tests.
- [x] PASS Intentional 401/403/409/413/429 responses are asserted by tests.
- [x] PASS Caddy validation info logs are expected validation output.
- [x] PASS Playwright runner `NO_COLOR` warnings are tool environment warnings, not app failures.
- [x] PASS No test runner reported unexpected browser console failures.
- [x] PASS No Playwright trace/video failure artifact was produced.
- [x] PASS Health endpoints expose deployment dependency state.

### Coverage And Documentation

- [x] PASS `docs/coverage-report.md` exists.
- [x] PASS Coverage report enumerates 212 unique PRD requirement IDs.
- [x] PASS Coverage report maps FR requirements to passing evidence.
- [x] PASS Coverage report maps NFR requirements to passing evidence.
- [x] PASS Coverage report maps visual requirements to passing evidence.
- [x] PASS Coverage report maps ownership requirements to passing evidence.
- [x] PASS Coverage report maps state lifecycle requirements to passing evidence.
- [x] PASS QC sign-off has more than 100 pass checkpoints.

## Skips

- Bats: 8 Linux-only systemd checks skipped on macOS. They are covered by CI Linux lanes and their template assertions are present locally.
- Pester: 1 platform-specific skip on macOS for `config.json has user-only ACL on Windows`; the skipped assertion requires Windows ACL APIs. The suite still verifies install, scheduler, catch-up, Mutex, and performance behavior under PowerShell Core.

## Runtime Notes

- Full API integration suite: 504 seconds. Functional result is green; the original subtask runtime target of under 60 seconds is not met by the current 79-file real-Supabase suite.
- Default E2E suite: 58 seconds.
- Acceptance E2E suite: 103 seconds.
- Bats suite: 24 seconds.
- Pester suite: 15 seconds.

## Log Notes

The API, unit, and deployment logs contain expected negative-path warnings or info logs for validation failures, rate limits, fraud rejections, missing cookies, invalid credentials, Caddy validation, and the Vite CJS deprecation warning emitted by the current toolchain. Each warning class is associated with a test that asserts the expected response or behavior. The final default and acceptance Playwright logs did not contain unexpected webserver errors or color-environment warnings.
