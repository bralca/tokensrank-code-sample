# Dashboard refresh and redesign — September 14, 2026

## Plan and implementation

- [x] Trace local file discovery, usage readers, SQLite rollups, startup, and scheduled imports.
- [x] Run the readers against actual Claude, Codex, and OpenCode files.
- [x] Import immediately on app startup; retain manual refresh and the configurable timer.
- [x] Keep local numbers independent of pricing/GitHub availability.
- [x] Publish usage numbers to the local UI before the slower code-evidence pass finishes.
- [x] Prevent simultaneous manual and scheduled imports.
- [x] Preserve the last successful counters for sources whose reader fails; bound reader runtime.
- [x] Skip unchanged JSONL files using parser version, size, modification time, and a content-hash fallback.
- [x] Replace tool evidence transactionally per successfully read file. Keep evidence when reading fails.
- [x] Index source-path lookup in SQLite (additive schema migration 8).
- [x] Preserve ccusage-owned counts when refreshing reference pricing; do not overwrite them with raw parser aggregates.
- [x] Replace the dark profile and leaderboard with a consistent light design.
- [x] Highlights first; separate Overview, Models, and Activity tabs. Default local view: last 30 days.
- [x] Count daily sessions once across model rows; retain cents for small API values.
- [x] Show full local model list, meaningful empty states, real time ranges, and API value labeling.
- [x] Make local settings and publishing light, with advanced diagnostics collapsed.
- [x] Show most-used models on community rows; use period-specific stored API values.
- [x] Make sign-in consistent with the new design.
- [x] Verify timer, overlap, reader recovery, file deduplication, UI refresh, types, and production build.
- [x] Replace green accents with selectable Cobalt, Violet, Graphite, and Coral palettes across local and public dashboards.
- [x] Rework the public homepage as a table-first usage index: compact 24-hour activity strip, tool/time filters, rank, builder, tokens, API value, most-used model, and rank movement.
- [x] Remove the public introduction and promotional sections; move ranking definitions into a compact disclosure.
- [x] Keep all columns available through horizontal scrolling on mobile, with rank, builder, and tokens visible first.

## Color and leaderboard revision

The default accent is Cobalt on neutral white and light-gray surfaces. The header's accent menu offers four live alternatives. A host-scoped appearance cookie carries the choice between the local and public ports; it contains only the palette name. Charts, tabs, buttons, model highlights, publishing, and settings use shared color variables.

The public page now opens directly on AI usage rankings. Its columns use existing published data; no trend series or community numbers were fabricated for the design. Model labels omit the date suffix while keeping the original identifier in a tooltip. The source and period filters share a pending state to prevent a second selection from overwriting an in-flight selection. Keyboard navigation and profile links remain available.

For this revision, the 92 web tests, web type check, lint (zero errors, eight existing warnings), and production web build passed. Manual checks covered all four accents, persistence across reload and local/public previews, narrow-screen table scrolling, desktop layout, combined source/time filters, and keyboard filter selection.

## How updates work

The app reads usage counters through bundled ccusage readers for Claude, Codex, and OpenCode. It separately parses raw files for local evidence linking AI activity to code. SQLite stores both; Supabase is used only for the public side.

Opening the local app now starts an import immediately (unless the explicit test-only startup override is set). A manual Refresh now action starts the same pipeline. When automatic updates are enabled in Settings, the local API schedules further updates at the configured interval. Closing the browser tab does not stop the API. Stopping the local app does; there is no installed operating-system daemon. Reopening the app catches up. The timer resumes after sleep and does not overlap an existing import.

Usage summaries are available before file evidence and GitHub enrichment finish. The dashboard polls refresh status every five seconds while visible and fetches a new profile when usage changes. Pricing or GitHub failures do not prevent the local counters from updating. A failed tool reader keeps that tool’s prior totals and surfaces a partial result.

First imports can take longer because they index historical evidence. SQLite migration 8 adds an index for source-file evidence lookup. Subsequent scans skip unchanged JSONL files; SQLite-backed OpenCode data is always read because its WAL can change independently of the main database file.

## Preview data and privacy

The existing preview still uses the SQLite safety copy from the previous publishing audit. Its refresh interval is now 15 minutes, with automatic publishing off. The original `~/.tokensrank` database remains preserved. This is a backup of the existing local database, not a new storage service. A normal `pnpm dev:both` invocation uses the original local database and enables normal startup refresh behavior.

No raw prompts, transcripts, or source files were published. The public preview still uses the existing Supabase development schema; its old test profiles are not real community activity. GitHub sign-in has now been verified in the browser. A real-account publication still requires connecting the local app and choosing Post now.

## Validation

The reader found 8,642 sessions on the first check (185 Claude, 7,918 Codex, 539 OpenCode), with activity through September 13/14. Counts can increase as the user continues working. The 30-day dashboard shows current models and sessions rather than the June snapshot.

Automated checks cover startup ingestion, 15-minute scheduling, pause, overlapping manual/timer requests, external-service failure, failed-source preservation, append deduplication, unchanged-file skipping, indexed evidence lookup, and refreshing the visible profile before code attribution finishes. The existing publishing regressions remain in place.

Production builds now explicitly use `NODE_ENV=production`, preventing a development `.env.local` value from breaking Next's build.

### Completed live check

A real restart at 00:19:48 UTC automatically triggered the startup import. Usage was refreshed at 00:19:52; the complete update finished at 00:21:47 with no error. It scanned 8,664 local files, deduplicated existing events, refreshed GitHub evidence, and set the next run for 00:36:47. Automatic publishing remained off. Recoverable Codex counter-reset notes stay in diagnostics and no longer incorrectly fail an otherwise successful update.

Final automated results: 733 unit tests across 78 files, 92 web tests across 15 files, workspace type checks, and the production build passed. Lint has no errors and eight existing warnings. Browser checks covered desktop and mobile overview, model/time filters, community populated and empty states, publishing controls, and schedule settings.

Time ranges on the local dashboard use UTC calendar days, matching the stored daily usage totals. Sessions are counted once on their latest activity date, so the daily chart and headline agree for 7 days, 30 days, and all time. Code-contribution details are explicitly labeled all time.

## Onboarding and GitHub browser audit — September 14

The actual Chrome walkthrough reproduced the public import page linking to its own `/local/setup` route. That route called the public API and failed with 404. Public-to-local links now use a configured local app address; the paired preview uses port 3100. Old `/local/*` links on the public preview redirect there too. Standalone installs default to localhost:3000 and can override `NEXT_PUBLIC_LOCAL_APP_URL`.

GitHub's OAuth callback now exchanges a session once, clears credentials from the URL immediately, handles expired/failed callbacks with a sign-in retry, and returns to `/me`. Returning users no longer repeat repository selection and imports after every sign-in. The public navigation recognizes a signed-in account; protected pages still validate the session on the server.

Account, import, profile settings, repository setup, legacy onboarding, and local setup now use the shared light palette. Local setup reads usage without requiring GitHub. Repository linking is optional in Settings. Public account setup presents three steps: open the local app, create a connection code, then review and share. Manual folder imports and advanced account history/keys are collapsed. Profile saves show a pending state, handle failures, and return to the account. Blank display names fall back to the GitHub handle. Empty profiles no longer present zero-filled calendar days as active days.

Live browser coverage:

- Signed out, started GitHub sign-in from the leaderboard, completed the existing authorized GitHub/Supabase flow, and returned to the account successfully.
- Opened account settings, verified invalid X handles block saving, and saved the existing blank fields successfully.
- Loaded 51 GitHub repositories with the existing three selections and checked filtering; selections were not changed.
- Created and copied a connection code, opened the real local app from the account, and verified the old public `/local/setup` link redirects correctly.
- Triggered a real local file read from setup; 8,665 files were discovered, and existing totals were available while the update completed. Open my dashboard completed setup successfully.
- Checked desktop and 390px layouts. Fixed manual import controls overflowing the phone viewport; verified content width equals viewport width.

The live test did not redeem a device connection code or post this account's real local usage to the public leaderboard. No manual folder payload was uploaded. Publishing integration coverage from the earlier repair remains separate from this browser audit.

Regression coverage adds Strict Mode callback exchange, immediate credential cleanup, failed/expired callbacks, and local app destination selection. The web suite has 98 passing tests; type checking, lint (zero errors, seven existing warnings), and the production build pass.

## Large-screen proportions

The leaderboard now uses a fluid container instead of a fixed 1440px cap. At a 2560px viewport, its table is 1904px wide (74% of the viewport), compared with 1360px previously (53%). At 3840px, it expands to 2904px. The header, activity strip, table, and footer share the same gutters.

Primary table text starts at 16px and grows to 18px on 4K displays; secondary labels, filters, buttons, and avatars are larger too. The shared type scale uses rem-based units and fluid CSS sizing, with no CSS zoom or transforms. Local dashboards are wider, highlight values are larger, and desktop charts have more height. Setup/account screens keep comfortable reading widths while inheriting the more legible typography.

Browser checks covered the 2560px display, a 1440px desktop viewport, a 3840px 4K viewport, and 390px/320px phone layouts. On phones, the leaderboard scrolls inside its table container, and local section/time controls wrap to separate rows. Model summaries use a single column on narrow screens. The production web build passed.
