# Publishing repair plan — September 14, 2026

Architecture retained: local dashboard → local SQLite; public dashboard/API → existing Supabase. Both dashboard applications can run on this computer. A disposable PostgreSQL instance was used only for automated failure tests and has been removed.

## Completed

- [x] Check external access first. Restore the existing Supabase projects and confirm development GitHub OAuth, database access, and local GitHub repository access. No replacement keys needed.
- [x] Allow machine-authenticated publishing requests while retaining browser origin checks. Accept bounded exports up to 32 MB.
- [x] Add OpenCode and missing model/cost columns to the publishing database.
- [x] Replace published aggregates atomically. Failed replacement preserves the previous data.
- [x] Store verification jobs durably, recover expired worker leases, retry temporary failures, serialize publications, and resume public-summary updates after restart.
- [x] Consume connection codes atomically; persist the local destination and expiry; bind credentials to that destination; support connection checks and revocation/disconnection.
- [x] Show disconnected/expired/unreachable states, disable premature posting, poll publication progress, and link to the public profile after completion.
- [x] Fix duplicate code attribution when multiple sessions/models reference the same commit. Model shares now preserve the total using linked-token weighting and integer rounding.
- [x] Mark successful nonempty publications as verified and clear previous summary totals when publishing an empty replacement.
- [x] Repair root environment loading, the API production entry point, unit/integration test separation, and CI build configuration. Add an isolated publishing CI job.
- [x] Apply prerequisite migrations 0026 and 0033–0036 to the existing development Supabase project; allow its GitHub callback at localhost:3200.
- [x] Add `pnpm dev:both` and verify both applications start together.
- [x] Verify the repaired browser controls and the GitHub redirect to the existing Token Rank OAuth app.
- [x] Remove the disposable PostgreSQL instance and temporary aggregate export files.

## Validation

- Root unit suite: 728 passing tests.
- Web suite: 90 passing tests, including publication progress polling.
- Publishing integration suite: 9 passing checks against real local PostgreSQL and PostgREST, including the user's 2,277,401-byte export with 4,893 sessions. GitHub results were deterministic fixtures for these tests; no user export was sent to Supabase.
- Database tests cover a fresh installation, test-schema reset, all aggregate families, OpenCode, code reuse, identity mismatch, expiry, revocation, large uploads, rollback, retries, lease recovery, summary recovery, and empty replacement.
- Workspace build and type checks pass. Lint has no errors; 8 existing warnings remain.
- Static privacy checks, all 8 privacy Bats checks, and the frontend secret audit pass.
- Production API bundle starts successfully and serves health and OAuth routes. Development Supabase accepts the publishing queue RPC.

## Remaining user/external steps

- The browser is not signed into GitHub. Complete **Continue with GitHub** at `http://localhost:3200/auth/sign-in`, then create a local publish code on `/me`. The authenticated callback and a real GitHub verification/publish under the user's account still need this sign-in.
- Public internet hosting is deferred following the user's choice to test locally. No TokensRank server exists in the connected DigitalOcean account. Production Supabase still needs application migrations/OAuth configuration when deployment is chosen; domain routing also remains a deployment task.
- Hosted GitHub Actions integration/performance jobs still require repository secrets. The new local publishing job does not. This workspace's changes have not been pushed, so a remote CI result is not claimed.

See [local publishing instructions](LOCAL_PUBLISHING.md) for the two dashboards, startup command, and test workflow.
