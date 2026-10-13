import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ProfileResponse} from '@tokensrank/shared';
import {EvidencePanel,CategoryStandings} from './EvidencePanel';

const profile={window:'7d',evidence:{github_login:'builder',published_at:'2026-06-01T12:00:00Z',output_tokens:20,
  usage:{version:1,sources:[{source:'codex',daily_basis:'event_dates',read_at:'2026-06-01T11:00:00Z',unpriced_models:['unknown-price']}],attribution:null},
  contribution:null,standings:[{kind:'tool',key:'codex',slug:'codex',rank:2,builders:5}]}} as ProfileResponse;
it('distinguishes connected identity, submitted usage, missing prices and unshared code',()=>{
  const html=renderToStaticMarkup(<EvidencePanel profile={profile} local={false}/>);
  expect(html).toContain('Submitted by the builder');
  expect(html).toContain('does not verify their token usage');
  expect(html).toContain('API value is partial');
  expect(html).toContain('Code contributions were not included');
  expect(html).not.toContain('0 GitHub commits');
});
it('keeps category scope and population visible and preserves the selected period',()=>{
  const html=renderToStaticMarkup(<CategoryStandings profile={profile}/>);
  expect(html).toContain('/tools/codex?period=7d');
  expect(html).toContain('of 5 builders');
  expect(html).toContain('#2');
});
