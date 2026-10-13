import {it,expect} from 'vitest';
import {observedActivity} from './observed-activity';
it('counts distinct recorded dates and Monday-based UTC weeks, without session or gap assumptions',()=>{
  expect(observedActivity([{date:'2026-06-07',tokens_total:10},{date:'2026-06-07',tokens_total:100},
    {date:'2026-06-08',tokens_total:1},{date:'2026-06-09',tokens_total:0},{date:'2026-06-22',tokens_total:1}]))
    .toEqual({activeDays:3,activeWeeks:3,first:'2026-06-07',last:'2026-06-22'});
  expect(observedActivity([{date:'2026-02-30',tokens_total:1},{date:'2026-99-99',tokens_total:1}])).toEqual({activeDays:0,activeWeeks:0,first:null,last:null});
});
