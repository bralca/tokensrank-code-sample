import type { ProfileResponse } from '@tokensrank/shared';
import { formatTokens, formatCost, modelLabel } from '../LeaderboardTable';
import { unpricedModelsInPeriod } from '../../lib/usage-pricing';

export function UsageInsights({profile}:{profile:ProfileResponse}) {
  const models = [...profile.models.models].sort((a,b)=>b.cost-a.cost);
  const value = profile.at_glance.cost_usd_total;
  const mix = profile.token_mix;
  const total = profile.at_glance.tokens_total;
  const partialValue=unpricedModelsInPeriod(profile).size>0;
  const parts = mix ? [['Fresh input',mix.input],['Output',mix.output],['Reused context',mix.cache_read],['Cache creation',mix.cache_write]] as const : [];
  const accounted = parts.reduce((n,[,v])=>n+v,0);
  // Older/foreign data can have overlapping counters. Never display an invented partition.
  const hasMix = mix && total>0 && accounted===total;
  if (!total) return null;
  return <div className="usage-insights" aria-label="Your usage insights">
    <section className="dash-card"><p className="dash-eyebrow">API value by model</p><h2>Where your usage adds up</h2>
      <dl className="insight-breakdown">{models.filter(m=>m.cost>0).slice(0,4).map(m=><div key={m.name}><dt>{modelLabel(m.name)}</dt><dd>{formatCost(m.cost)}</dd><div className="insight-bar"><span style={{width:`${value?Math.min(100,100*m.cost/value):0}%`}}/></div></div>)}</dl>
      <p>{models[0]?.cost>0 && value>0 ? `${modelLabel(models[0].name)} accounts for ${(100*models[0].cost/value).toFixed(1)}% of your ${partialValue?'priced usage':'estimated API value'}. `:''}API prices help compare your model mix; your subscription bill may be different. {partialValue?'This estimate excludes models with missing prices.':''}</p>
    </section>
    <section className="dash-card"><p className="dash-eyebrow">Token composition</p><h2>What makes up the total</h2>
      {hasMix ? <><div className="insight-amount">{(100*mix.cache_read/total).toFixed(1)}% <span className="dash-side-note">reused context</span></div><dl className="insight-breakdown">{parts.map(([label,amount])=><div key={label}><dt>{label}</dt><dd>{formatTokens(amount)}</dd></div>)}</dl><p>Reused context is counted again when a tool reads cached input. Output includes reported reasoning tokens; they are not added a second time.</p></> : <p>A comparable token breakdown is unavailable for this import. Your recorded total is shown above.</p>}
    </section>
  </div>;
}
