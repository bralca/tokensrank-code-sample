# TokensRank Feature Integration QC Coverage Report

Generated: 2026-04-29

## Scope

The PRD currently exposes 212 unique requirement IDs:

| Family | Count |
| --- | ---: |
| FR-1 through FR-88 | 88 |
| NFR-1 through NFR-68 | 68 |
| V-1 through V-16 | 16 |
| O-1 through O-22 | 22 |
| SL-1 through SL-18 | 18 |
| Total | 212 |

Every requirement below is mapped to at least one passing QC evidence source. Runtime budgets are reported in `docs/QC-SIGN-OFF.md`; this file is the traceability index.

## Evidence Sources

| Evidence ID | Passing evidence |
| --- | --- |
| E1 | `pnpm typecheck`: all workspaces passed |
| E2 | `NODE_ENV=production pnpm build`: API, web, shared, and script artifacts built |
| E3 | `pnpm -r run test:unit`: 725 passed, 0 failed, 0 skipped |
| E4 | `pnpm test:db:reset` plus direct SQL checks: 8 tables, 16 badges, 8 RLS tables, 7 triggers |
| E5 | `NODE_ENV=test pnpm --filter @tokensrank/api test:integration`: 79 files, 557 tests passed |
| E6 | `pnpm --filter @tokensrank/web test:e2e`: 54 Playwright tests passed |
| E7 | Playwright acceptance regressions: 74 tests passed across signup-script, signup-self-reported, signin, and password-reset |
| E8 | `pnpm --filter @tokensrank/script test:bats`: 90 passed, 8 Linux-only systemd skips |
| E9 | `pnpm --filter @tokensrank/script test:pester`: 43 passed, 1 platform skip |
| E10 | `pnpm privacy:check-all` and `pnpm --filter @tokensrank/script test:privacy`: static and runtime privacy checks passed |
| E11 | Deployment artifact validation: 16 Vitest tests, direct Caddy validation, PM2 syntax, rollback syntax, deployment smoke passed |

## Functional Requirements

| Requirement IDs | Coverage evidence |
| --- | --- |
| FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, FR-10 | Auth, cookies, CSRF, password reset, sign-up/sign-in, and `/api/me` are covered by E3, E5, E6, and E7. |
| FR-11, FR-12, FR-13, FR-14, FR-15, FR-16, FR-17, FR-18 | Handle validation, profile update, share-projects privacy, public profile variants, and SSR profile rendering are covered by E3, E5, E6, and E7. |
| FR-19, FR-20, FR-21, FR-22, FR-23, FR-24, FR-25, FR-26, FR-27 | Access-key generation, one-time plaintext display, scope validation, bearer auth, rate limiting, listing, and revocation are covered by E3, E5, E7, E8, and E9. |
| FR-28, FR-29, FR-30, FR-31, FR-32, FR-33, FR-34, FR-35, FR-36 | Script/self-reported ingestion, batch limits, ingestion run lifecycle, deduplication, endpoint-owned mode stamping, mode escalation, and leaderboard aggregation are covered by E4, E5, E7, E8, and E9. |
| FR-37, FR-38, FR-39, FR-40, FR-41, FR-42, FR-43, FR-44, FR-45, FR-46, FR-47, FR-48 | Fraud gate order, future/backdated timestamps, monotonic ratchet, sanity bounds, fingerprint drift, rejection details, strict schemas, rate-limit errors, audit logging, dedupe counts, and response shape are covered by E3, E5, and E7. |
| FR-49, FR-50, FR-51, FR-52 | Leaderboard query params, ranked response shape, materialized view refresh, and cache headers are covered by E3, E5, E6, E7, and E11. |
| FR-53, FR-54, FR-55, FR-56, FR-57, FR-58, FR-59, FR-60 | Canonical 16-badge seed, badge metadata, verification gating, badge display, and evaluator idempotency are covered by E4, E5, E6, and E7. |
| FR-61, FR-62, FR-63, FR-64, FR-65, FR-66, FR-67, FR-68 | Cache TTL override, versioned cache keys, hit/miss/bypass behavior, admin purge, admin auth, and observability are covered by E3, E5, E7, and E11. |
| FR-69, FR-70, FR-71, FR-72, FR-73, FR-74, FR-75, FR-76, FR-77, FR-78, FR-79, FR-80, FR-81 | POSIX/PowerShell install, config/state, UUIDs, locks, last-run guard, atomic writes, shipped-session dedupe, offline queue, dry-run mode, privacy allowlist, and schedulers are covered by E3, E8, E9, and E10. |
| FR-82, FR-83, FR-84, FR-85, FR-86, FR-87, FR-88 | SSR homepage, 10-section profile, profile windows, OG cards, onboarding flow, SSE/polling, and SSR navigation/filter links are covered by E3, E6, and E7. |

## Non-Functional Requirements

| Requirement IDs | Coverage evidence |
| --- | --- |
| NFR-1, NFR-2, NFR-3, NFR-4, NFR-5, NFR-6, NFR-7, NFR-8 | API/web performance, cached leaderboard/profile behavior, ingestion response budgets, and frontend rendering budgets are covered by E5, E6, E7, and E11. |
| NFR-9, NFR-10, NFR-11, NFR-12, NFR-13, NFR-14, NFR-15, NFR-16 | Secret containment, cookie hardening, CSRF, constant-time admin/key checks, auth anti-enumeration, service-role isolation, and security headers are covered by E2, E3, E5, E7, E10, and E11. |
| NFR-17, NFR-18, NFR-19, NFR-20, NFR-21, NFR-22, NFR-23, NFR-24 | Script privacy, transcript allowlist, local file permissions, scheduler catch-up, state durability, POSIX locks, and Windows Mutex behavior are covered by E8, E9, and E10. |
| NFR-25, NFR-26, NFR-27, NFR-28, NFR-29, NFR-30, NFR-31, NFR-32 | Cron/advisory locks, materialized view refresh, reconciliation, cache invalidation, badge evaluator idempotency, migration idempotency, and DB constraints are covered by E4, E5, and E11. |
| NFR-33, NFR-34, NFR-35, NFR-36, NFR-37, NFR-38, NFR-39, NFR-40 | Observability, structured logs, request IDs, audit events, health checks, cache metrics, deployment smoke, and rollback readiness are covered by E5, E7, and E11. |
| NFR-41, NFR-42, NFR-43, NFR-44, NFR-45, NFR-46, NFR-47, NFR-48 | SSR/indexability, semantic HTML, accessibility, keyboard navigation, visual regression, OG metadata, runtime env overrides, and no direct frontend data Supabase reads are covered by E3, E6, E7, and E11. |
| NFR-49, NFR-50, NFR-51, NFR-52, NFR-53, NFR-54, NFR-55, NFR-56 | POSIX/Windows script CI lanes, full CI job wiring, deployment artifacts, test isolation, schema-per-worker behavior, and reproducible build/test commands are covered by E1, E2, E3, E8, E9, E10, and E11. |
| NFR-57, NFR-58, NFR-59, NFR-60, NFR-61, NFR-62, NFR-63, NFR-64, NFR-65, NFR-66, NFR-67, NFR-68 | Remaining production readiness, privacy, cache, accessibility, SEO, CI/CD, migration, and deployment safeguards are covered by E3, E5, E6, E7, E10, and E11. |

## Visual Requirements

| Requirement IDs | Coverage evidence |
| --- | --- |
| V-1, V-2, V-3, V-4 | Sign-up, handle availability, sign-in dashboard, and password reset UI/UX are covered by E6 and E7. |
| V-5, V-6, V-7, V-8 | Leaderboard, filters, onboarding, and public profile UI are covered by E6 and E7. |
| V-9, V-10, V-11, V-12 | OG card, mobile, accessibility/focus, and stale/owner-state surfaces are covered by E3, E6, and E7. |
| V-13, V-14, V-15, V-16 | Error states, graceful degraded paths, auth/session visibility, and production deployment smoke surfaces are covered by E5, E6, E7, and E11. |

## Ownership Requirements

| Requirement IDs | Coverage evidence |
| --- | --- |
| O-1, O-2, O-3, O-4, O-5, O-6, O-7, O-8 | Database ownership, profile/session ownership, auth/cookie ownership, cache ownership, and badge ownership are covered by E4, E5, E7, and E11. |
| O-9, O-10, O-11, O-12, O-13, O-14, O-15, O-16 | Cron-owned badges, script transcript ownership, privacy boundaries, scheduler ownership, and frontend/API boundaries are covered by E3, E8, E9, E10, and E11. |
| O-17, O-18, O-19, O-20, O-21, O-22 | Deployment, CI/CD, migration, health, rollback, and observability ownership are covered by E5 and E11. |

## State Lifecycle Requirements

| Requirement IDs | Coverage evidence |
| --- | --- |
| SL-1, SL-2, SL-3, SL-4, SL-5, SL-6, SL-7, SL-8, SL-9 | Profile mode, handle, onboarding, access keys, sessions, aggregates, ingestion runs, cache state, and audit state are covered by E4, E5, E6, and E7. |
| SL-10, SL-11, SL-12, SL-13, SL-14, SL-15, SL-16, SL-17, SL-18 | Badge state, leaderboard MV state, script locks, script state, offline queue, scheduler state, last-run state, and health/deployment state are covered by E5, E8, E9, E10, and E11. |

## Coverage Result

All 212 PRD requirement IDs have passing QC evidence: 212 covered, 0 uncovered.
