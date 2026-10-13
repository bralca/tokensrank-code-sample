import type { LeaderboardRow } from '../../../../packages/shared/src/schemas/leaderboard';

/** Counts published top-model choices; these are builder counts, not token shares. */
export function modelFavorites(rows: LeaderboardRow[]) {
  const models = new Map<string, LeaderboardRow[]>();
  for (const row of rows) {
    if (!row.top_model) continue;
    const builders = models.get(row.top_model) ?? [];
    if (!builders.some(builder => builder.handle === row.handle)) builders.push(row);
    models.set(row.top_model, builders);
  }
  return [...models].map(([model, builders]) => ({ model, builders }))
    .sort((a, b) => b.builders.length - a.builders.length || a.model.localeCompare(b.model));
}
