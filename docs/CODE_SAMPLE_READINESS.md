# Code sample verification — October 13, 2026

This snapshot is an experimental project, prepared from the newer local implementation and its sortable-leaderboard changes. It is a source-code sample, not a production launch sign-off.

## Reproduction environment

- macOS on Apple Silicon; Node.js 22.23.3; pnpm 10.27.0.
- Fresh dependency installation with the checked-in lockfile.
- Only `.env.local.example` was copied into `.env.local`; no hosted credentials were used.
- PostgreSQL 14 and PostgREST 16.4 for disposable publishing tests.
- Google Chrome for the local browser test, using synthetic usage and temporary SQLite storage.

## Results

| Check | Result |
| --- | --- |
| Frozen dependency installation | Passed |
| Workspace type checking | Passed |
| Lint | No errors; seven existing warnings |
| Core/API/local tests | 771 passed |
| Web tests | 126 passed |
| SQL/HTTP publishing tests | 20 passed; one optional saved-export test skipped |
| Local browser test | Passed on desktop and 390-pixel mobile viewport |
| All workspace production builds | Passed |
| Frontend bundle credential audit | Passed |
| Script payload privacy check | Passed |
| Production dependency advisory scan | Zero reported advisories on this date |
| Source credential checks | Passed |

The core and web suites overlap in a few shared tests; their counts should not be added as a unique-test total.

The browser test starts the actual local API and frontend, checks the API's token and session totals against the UI, switches model/time views and checks mobile overflow and browser errors. It does not simulate a production GitHub sign-in or send a real publication. Publishing behavior is tested separately against disposable PostgreSQL and PostgREST.

## GitHub verification

[GitHub Actions run 38384812494](https://github.com/bralca/tokensrank-code-sample/actions/runs/38384812494) passed for code commit `83e42fc` on October 13, 2026:

- Lint, type checking, production builds, source credential checks and privacy checks.
- Core and workspace unit tests, plus the local browser test on Linux.
- Publishing tests using isolated PostgreSQL and PostgREST.
- Installation-script suites on Linux and macOS, and all 45 Windows tests.

Hosted integration, performance and hosted browser jobs were skipped because they require a separately configured test account. The later documentation-only commit records these results without changing the tested code.

## Changes made for review

- Updated affected dependency versions and pinned the tested Node.js line. The initial Node 24 run crashed in native SQLite cleanup; Node 22 passes. Newer Node majors are not claimed to be supported.
- Added a minimal local environment example and corrected the checkout/setup instructions in the README and Join page.
- Added a browser smoke test that needs no hosted credentials.
- Added credential detection for embedded Supabase JWTs and other key formats. Gitleaks extends its defaults with an explicit JWT rule. Narrow exceptions cover a breached-password hash fixture and destructured chart property names; no credential-bearing paths are excluded wholesale.
- Made hosted CI tests opt-in because they require a dedicated test project and create fixture accounts.
- Fixed Windows file ACL inheritance, built shared schemas before installer tests, and corrected platform-dependent assertions and outdated reinstall expectations.
- Prepared the shareable source without private development history, archived planning conversations or historical operational reports. Local environment files, databases and runtime exports are excluded.

## Limits

No production deployment, fresh GitHub OAuth browser flow, live publication, or Windows browser test was performed for this snapshot. Historical development notes do not establish current production readiness. Existing lint warnings and server-rendered chart-size warnings remain; the checked browser rendered correctly with no page errors.

Secret scans reduce risk; they do not prove that every possible sensitive value or vulnerability has been found. The source was checked using Gitleaks, explicit key/JWT rules and exact matching against configured credentials, with matched values withheld from reports.
