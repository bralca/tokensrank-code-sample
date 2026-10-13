# Reputation implementation — September 14, 2026

1. Replace final-session-date token allocation with the reader's UTC event-day totals. Preserve the last successful source snapshot on errors, reconcile totals, and retain an explicitly labeled fallback for older imports.
2. Recover observed session timestamps locally. Keep elapsed spans distinct from active work; do not invent duration or concurrency awards.
3. Publish a small, reviewed evidence summary: calculation method, source coverage, and optional attribution coverage. Store it atomically with the approved publication. Show identity, publication freshness, category standing, and contribution evidence separately.
4. Use the existing warm neutral/orange styles, compact highlights, and expandable detail. Make the receipt explain the fields before confirmation.
5. Verify parsing, restart/retry behavior, consent/privacy, publication replacement, public profile/rankings, and desktop/mobile browser flows. Keep test fixtures out of the existing Supabase database.

No universal quality score, spending reward, or automatic publication is introduced. Repository release, licensing, hosting, and distribution remain outside this metric implementation.

## Implementation status

Steps 1–4 are implemented. Automated publication replacement and real-export tests pass in the disposable database. Browser layout, private metrics, receipt controls and existing public category/profile routes were checked. A fresh public usage update is pending receipt confirmation; real optional-code publication and release/distribution are not claimed complete. See [the metric contract and validation](REPUTATION_METRICS_REVIEW.md).
