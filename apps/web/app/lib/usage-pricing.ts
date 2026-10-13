import type { ProfileResponse } from '@tokensrank/shared';

/** A price missing elsewhere in the history does not make this period partial. */
export function unpricedModelsInPeriod(profile: ProfileResponse): Set<string> {
  const used = new Set(profile.models.models.filter(model => model.tokens > 0).map(model => model.name));
  return new Set((profile.evidence?.usage?.sources ?? []).flatMap(source => source.unpriced_models).filter(model => used.has(model)));
}
