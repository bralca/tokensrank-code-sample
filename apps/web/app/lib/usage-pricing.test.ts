import { it, expect } from 'vitest';
import type { ProfileResponse } from '@tokensrank/shared';
import { unpricedModelsInPeriod } from './usage-pricing';

it('only marks estimates partial when unpriced models occur in the selected period', () => {
  const profile = {
    models: { models: [{ name: 'priced', tokens: 100 }] },
    evidence: { usage: { sources: [{ source: 'opencode', unpriced_models: ['unpriced'] }] } },
  } as ProfileResponse;
  expect([...unpricedModelsInPeriod(profile)]).toEqual([]);
  profile.models.models.push({ name: 'unpriced', tokens: 10 } as ProfileResponse['models']['models'][number]);
  expect([...unpricedModelsInPeriod(profile)]).toEqual(['unpriced']);
});
