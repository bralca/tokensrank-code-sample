# Migration Plan 0010: Reconcile to Spec

Source audit: Tokens Rank Dev, public schema, queried 2026-04-27.

## Current vs. Target State

| Area | Current state | Target state | Migration action |
| --- | --- | --- | --- |
| `profiles.mode` | `profiles_mode_check` allows `NULL`, `A`, `B`, `script_verified`, `self_reported`; current data has 1 row with `A` | Allows only `NULL`, `script_verified`, `self_reported` | Drop `profiles_mode_check`, coerce `A` to `script_verified` and `B` to `self_reported`, add canonical check |
| `ingestion_runs.status` | `ingestion_runs_status_check` allows `processing`, `completed`, `failed`; no current rows | Allows `processing`, `completed`, `partial`, `failed` | Drop old check, add canonical check with `partial` |
| `audit_events.severity` | `audit_events_severity_check` already allows `info`, `warn`, `critical`; no current rows | Allows only `info`, `warn`, `critical` | Drop/re-add canonical check for idempotent reconciliation; coerce any legacy `error` values to `critical` before adding |
| `badges` | 16 legacy slugs: `big_session`, `billion_club`, `claude_native`, `codex_native`, `first_million`, `hundred_million`, `multi_model`, `self_reported`, `streak`, `streak_100`, `streak_30`, `streak_7`, `ten_million`, `top_10`, `top_100`, `verified` | 16 design-canon slugs: `tier`, `iron_streak`, `operator`, `cache_whisperer`, `night_owl`, `multi_provider`, `conductor`, `outage_witness`, `reasoning_junkie`, `marathoner`, `detonation`, `long_context`, `defection_arc`, `two_tool`, `drifter`, `sniper` | Delete `profile_badges`, delete `badges`, then reseed canonical badge rows |

## Data Coercion Rules

- `profiles.mode = 'A'` becomes `script_verified`.
- `profiles.mode = 'B'` becomes `self_reported`.
- Existing `NULL`, `script_verified`, and `self_reported` profile modes are preserved.
- Any legacy `audit_events.severity = 'error'` becomes `critical` before the canonical severity check is added.
- Badge awards are intentionally wiped because legacy badge slugs no longer map to canonical design-canon badges.

## Redundant Policy Drop Checklist

The current public schema contains 7 redundant policies from the spec drift table. The eighth is a prior-branch legacy policy that only exists when `leaderboard_lifetime` is a table; current public has `leaderboard_lifetime` as a materialized view, so the migration must guard that drop conditionally.

- [ ] `access_keys_select_own` on `access_keys`
- [ ] `access_keys_update_own` on `access_keys`
- [ ] `sessions_select_own` on `sessions`
- [ ] `daily_aggregates_select_own` on `daily_aggregates`
- [ ] `badges_select_public` on `badges`
- [ ] `profile_badges_select_public` on `profile_badges`
- [ ] `ingestion_runs_select_own` on `ingestion_runs`
- [ ] `leaderboard_lifetime_select_public` on `leaderboard_lifetime` only when the relation is a legacy table with RLS policies

## Verification Checklist

- `SELECT DISTINCT mode FROM profiles` returns only `NULL`, `script_verified`, and `self_reported`.
- `ingestion_runs.status` accepts `partial`.
- `audit_events.severity` rejects `error`.
- `SELECT COUNT(*) FROM badges` returns `16` after this migration.
- `sessions.total_tokens` remains `GENERATED ALWAYS`.
- `sessions_dedup` remains unique on `(profile_id, source, session_id, file_sha256)`.
- Redundant policies above are absent after migration; Task 6.0 creates authoritative RLS policies.
