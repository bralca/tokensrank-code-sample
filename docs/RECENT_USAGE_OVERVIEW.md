# Recent usage overview

The local profile now leads with a private recap and the connected account’s public presence. Historical totals, model tables and activity remain below, under **Your history**. The existing warm orange design, readable type and responsive layouts are retained.

## Calculations

- **Last 7 complete days** uses the seven UTC dates before today. The comparison uses the preceding seven dates. Today contributes to the local all-time total and the historical filters, but not this comparison.
- Tokens and output tokens are sums of the existing daily aggregates. A day with records has a positive recorded token total. Gaps are not evidence of inactivity or work duration.
- Percentage change is `(latest / previous - 1) × 100`. It is unavailable when the previous total is zero, the history starts after the comparison window starts, a participating source lacks event-date provenance, or a source has not been read since the beginning of today (UTC).
- The read-through date is the oldest read timestamp across sources with recorded usage. It does not certify that every original file exists.
- Model shares use exact recorded model IDs and token counters. Changes are percentage points. Previously used models remain visible with zero recent tokens when a comparison is available. No model-family estimation, AI inference, activity-time estimate or productivity score is introduced.
- Exact daily counts are available in the expandable comparison table; paired bars provide the initial overview.

## Public presence and privacy

`GET /local/publish/presence` reads the saved connection’s already-public profile for the all-time window. The request sends no local usage, credentials, authorization header, cookies or request body. It rejects redirects, uses a five-second timeout, validates the expected account and distinguishes disconnected, unpublished, unavailable and published states.

The local page shows the actual overall position, up to two category positions, participant counts, published token total and publication date. Public category links use the connected public site. The difference between the local and published totals is described as a difference in totals; it is not assumed to be unpublished work, since imports and corrections can change totals in either direction.

The recap is a private profile response field and is not added to publishing payloads. **Review an update** opens the existing publishing wizard. Publishing still requires approval of its fixed receipt. The public profile overview also brings its existing category positions forward.

## Validation (2026-09-14)

- Root unit suite: 769 passing tests, including UTC boundaries, zero baselines, missing history, source freshness, model switches and credential-free public reads.
- Web suite: 122 passing tests, including recap and public-presence states.
- Isolated PostgreSQL publishing/explorer suite: 16 passed; optional imported-receipt fixture test skipped.
- Type checks and the production build passed across all packages. Web lint: no errors; seven pre-existing warnings.
- Browser checks with real local aggregates and the existing public account: desktop and 390px mobile layout, expandable daily comparison, historical period and model tabs, public category navigation. The mobile document has no horizontal overflow.
- No new publication or operational database reset was performed for this change.
