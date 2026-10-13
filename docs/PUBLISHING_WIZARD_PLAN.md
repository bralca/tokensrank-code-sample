# Guided publishing and aggregate privacy

Implement a single journey: leaderboard → setup explanation → local calculation → account connection → exact sharing receipt → explicit publish confirmation → progress and public profile.

- [x] Diagnose raw-vs-score cap, rename cache, missing file pages and author/committer-date mismatch.
- [x] Share canonical GitHub counting rules, preserve capped ranking, version old caches.
- [x] Finish regression checks and repair the two invalid verification penalties without publishing data.
- [x] Export aggregate daily/model counts only; no session IDs, times, file hashes or transcripts.
- [x] Make code contributions optional, off by default, with extra repository metadata listed in the receipt.
- [x] Freeze an expiring receipt on the local server; require confirmation of that exact snapshot to send.
- [x] Scheduled refreshes remain private; remove automatic publishing.
- [x] Guided local wizard with live calculation progress, privacy explanation, connection and receipt.
- [x] Public onboarding starts with how it works and actual install instructions; avoid a distracting mode chooser.
- [x] Browser account handoff replaces copying codes in the primary path; keep a manual fallback.
- [x] Browser-test the journey and test privacy, receipt tampering/expiry, failures and public aggregate rendering.

The local launcher currently requires a repository checkout. Do not claim a standalone installer exists.

## Verification completed September 14

- Root suite: 744 passing tests; focused GitHub/CLI/receipt/schedule checks: 27 passing.
- Web suite: 106 passing tests, including receipt confirmation, scope change, failed publishing, profile preparation, OAuth return routing, and the local return channel.
- Disposable PostgreSQL/PostgREST publication suite: 10 passed, one optional real-export fixture skipped. Tested schema-v2 aggregate-only publication, correct public cost/token totals, raw code verification with separately capped ranking, atomic replacement and durable jobs.
- API/local API/web type checks and production web build passed.
- Browser: public Share your usage → onboarding → local calculation → account → receipt; real signed-out GitHub OAuth round trip; automatic return/close; optional code error and usage-only recovery; 390px and large desktop layouts. User's actual receipt remains unapproved/unpublished.

The full OAuth browser test exposed a severed `window.opener` after GitHub navigation. The corrected flow returns the popup to the local origin, clears the one-use code from its fragment immediately, and hands it back on a nonce-bound local BroadcastChannel. The actual signed-out browser round trip passed after this correction.

Current external limitation: GitHub returned an exhausted account allowance during local code refresh, with reset at 2026-09-14 11:57:32 UTC. The refresh now stops promptly with a retry time instead of silently waiting. Usage-only publishing remains available, and the configured private refresh schedule can retry code later. New raw code totals for this real account have not yet been revalidated after the cache migration.
