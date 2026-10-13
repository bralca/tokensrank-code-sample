import {describe,it,expect} from 'vitest';
import {modelSlug,dimensionLabel,jsonLd,explorerFilters} from './explorer';
describe('public usage categories',()=>{
  it('keeps colliding readable names and dated model versions distinct',()=>{
    expect(modelSlug('model-a')).not.toBe(modelSlug('model/a'));
    expect(modelSlug('model-a-20260101')).not.toBe(modelSlug('model-a-20260201'));
    expect(modelSlug('GPT/4.1')).toMatch(/^gpt-4-1-[a-f0-9]{8}$/);
    expect(dimensionLabel('model','model-20260101')).toContain('20260101');
    expect(dimensionLabel('model','claude-sonnet-4-20250514')).toBe('Claude Sonnet 4 20250514');
    expect(dimensionLabel('model','claude-sonnet-4-5-20250929')).toBe('Claude Sonnet 4.5 20250929');
  });
  it('contains user-supplied text inside JSON-LD and normalizes filters',()=>{
    expect(jsonLd({name:'</script><script>alert(1)</script>'})).not.toContain('<');
    expect(explorerFilters({period:'invalid',offset:'-99'})).toMatchObject({period:'all',offset:0});
  });
});
