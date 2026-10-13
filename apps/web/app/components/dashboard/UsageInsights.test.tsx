import { describe,it,expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProfileResponse } from '@tokensrank/shared';
import { UsageInsights } from './UsageInsights';

function profile(mix:ProfileResponse['token_mix']):ProfileResponse {
  return {at_glance:{tokens_total:1000,cost_usd_total:10},models:{models:[{name:'model-a',tokens:1000,cost:10}]},token_mix:mix} as ProfileResponse;
}
describe('private usage insights',()=>{
  it('shows cache reuse without double-counting reasoning',()=>{
    const html=renderToStaticMarkup(<UsageInsights profile={profile({input:100,output:200,cache_read:650,cache_write:50,reasoning:150})}/>);
    expect(html).toContain('65.0%');expect(html).toContain('not added a second time');expect(html).toContain('$10.00');
  });
  it('does not manufacture a partition from overlapping or missing counters',()=>{
    expect(renderToStaticMarkup(<UsageInsights profile={profile({input:100,output:200,cache_read:650,cache_write:49,reasoning:0})}/>)).toContain('breakdown is unavailable');
    expect(renderToStaticMarkup(<UsageInsights profile={profile({input:1000,output:200,cache_read:650,cache_write:50,reasoning:0})}/>)).toContain('breakdown is unavailable');
    expect(renderToStaticMarkup(<UsageInsights profile={profile(undefined)}/>)).toContain('breakdown is unavailable');
  });
});
