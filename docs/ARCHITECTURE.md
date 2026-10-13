# TokensRank Architecture

## Cron Schedules

The Fastify API registers database maintenance jobs during startup after routes are mounted and before `listen()`.

| Job | Schedule | Timezone | Function | Purpose |
| --- | --- | --- | --- | --- |
| Leaderboard MV refresh | Every 5 minutes | UTC | `refreshLeaderboardLifetime()` | Archive `leaderboard_lifetime` to `leaderboard_previous`, then run `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_lifetime`. |
| Daily aggregates reconciliation | `5 0 * * *` | UTC | `reconcileAggregates()` | Recompute `daily_aggregates` from `sessions`, detect trigger drift, correct affected rows, and log critical audit events. |

Both jobs use Postgres advisory locks. The v1 deployment is single-instance, but the locks keep the jobs safe if a future deploy runs multiple API processes.

## FR-88 SSR Navigation

Leaderboard period/scope filters, leaderboard pagination, and profile window filters are URL-owned state. They render as plain `<a href>` links so every change performs a full SSR navigation. The homepage leaderboard calls `apiFetchWithMeta()` with `cache: 'no-store'` at the Next layer and relies on the Fastify LRU cache, making API cache-version bumps visible on the next SSR request. Profile pages continue to use `next: { revalidate: 60 }` for tagged frontend revalidation; no `useRouter`, `router.push()`, `useState()`, or `useEffect()` navigation logic is used for these FR-88 controls.

Disabled pagination boundaries are rendered as inert disabled buttons only when no navigation is available. Active filter and page transitions are always anchors with complete query state in the URL.
