# Sortable community leaderboard

The homepage defaults to estimated API value, highest first. The four metric columns—API value, tokens, sessions and active days—toggle between descending and ascending order. Sort state is in the URL (`sort=cost|tokens|sessions|active_days`, `order=desc|asc`), persists through tool/period filters and pagination, and resets the page when the metric or filter changes.

API value is calculated from published model pricing; it is not actual spending. Rows with unpriced models carry a partial-estimate label. Zero-value rows with published tokens remain eligible. Sessions use the separately published daily counts, avoiding duplication across models; sessions spanning several dates can count on each date. Active days count distinct UTC dates with positive usage. Top model means the most-used model by tokens in the selected tool and period.

`0042_sortable_usage_leaderboard.sql` adds `query_usage_leaderboard_sorted`. It ranks all eligible profiles before pagination and preserves existing trust adjustments. Rank 1 is the highest adjusted value for the selected metric; ascending order reverses the display, not the definition of rank. Ties resolve by profile ID. Eligibility and pricing coverage come from `public_usage_facts`.

The original ranking RPC retains its response shape and now uses the default API-value ordering. Public profile overall ranks and the homepage Today sidebar agree with that default. Model and tool category rankings still compare tokens and are labeled separately. API cache keys include the metric and direction.

Apply migration 0042 after 0041 in existing environments. The publishing setup check verifies the new RPC. No new publication, private-data collection or operational-data reset is required.

Validation: isolated PostgreSQL/PostgREST tests cover global sorting, ascending order, pagination, stable ties, zero API value, period/tool filtering, multi-model session counts, active dates, trust, hidden profiles and restricted RPC access. UI tests cover accessible column state, URL handling, pagination and partial/missing values.
