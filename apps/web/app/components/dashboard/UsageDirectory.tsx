import Link from 'next/link';
import type { UsageDimensionKind } from '@tokensrank/shared';
import { HomepageHeader } from '../homepage/Header';
import { ProjectFooter } from './Brand';
import { formatTokens, formatCost } from '../LeaderboardTable';
import { directoryPaths, dimensionLabels, dimensionLabel, dimensionPath, explorerFilters, explorerPeriods, loadUsageCatalog } from '../../lib/explorer';

export async function UsageDirectory({ kind, search }: { kind: UsageDimensionKind; search: Record<string,string|string[]|undefined> }) {
  const { period } = explorerFilters(search);
  const rows = await loadUsageCatalog(kind, period);
  const total = rows.reduce((n,r) => n+r.tokens,0);
  return <main className="dashboard dash-market"><HomepageHeader /><div className="dash-content">
    <div className="dash-page-title"><div><h1>{dimensionLabels[kind]}</h1><p className="dash-subtitle">Published AI usage across the community.</p></div>
      <nav className="dash-periods" aria-label="Usage period">{explorerPeriods.map(([key,label]) => <Link key={key} href={`${directoryPaths[kind]}?period=${key}`} className={`dash-button ${period===key?'dark':''}`} aria-current={period===key?'page':undefined}>{label}</Link>)}</nav></div>
    <nav className="explore-tabs" aria-label="Explore usage">{(['model','tool','provider'] as const).map(k => <Link key={k} href={`${directoryPaths[k]}?period=${period}`} aria-current={kind===k?'page':undefined}>{dimensionLabels[k]}</Link>)}</nav>
    <div className="explore-summary"><strong>{formatTokens(total)} <span>tokens</span></strong><p>{rows.length} {dimensionLabels[kind].toLowerCase()} · every eligible published profile is included</p></div>
    {rows.length ? <div className="explore-table-wrap"><table className="explore-table"><thead><tr><th>#</th><th>{kind==='model'?'Model':kind==='tool'?'Tool':'Provider'}</th><th>Tokens used</th><th>Share</th><th>Builders</th><th>API value</th></tr></thead><tbody>
      {rows.map((r,i) => <tr key={r.key}><td className="dash-muted">{i+1}</td><td><Link className="explore-name" href={`${dimensionPath(kind,r.slug)}${period==='all'?'':`?period=${period}`}`}>{dimensionLabel(kind,r.key)} <span aria-hidden="true">↗</span></Link>{kind!=='tool' && <small className="explore-id">{kind==='model'?r.key:r.tools.map(t=>dimensionLabel('tool',t)).join(' · ')}</small>}</td><td><strong>{formatTokens(r.tokens)}</strong><small className="explore-id">{r.output_tokens===null?"Output breakdown unavailable":`${formatTokens(r.output_tokens)} output`}</small></td><td><div className="explore-share"><span>{(100*r.tokens/total).toFixed(1)}%</span><i><b style={{width:`${100*r.tokens/total}%`}} /></i></div></td><td>{r.builders.toLocaleString()}</td><td>{r.api_value_partial?(r.api_value>0?`${formatCost(r.api_value)} · partial`:'Unavailable'):formatCost(r.api_value)}</td></tr>)}
    </tbody></table></div> : <div className="dash-empty-board"><h2>No published usage in this period</h2><Link href={directoryPaths[kind]} className="dash-button">View all time</Link></div>}
    <details className="explore-method"><summary>About these numbers</summary><p>Ranked by total recorded tokens, including cached context. A builder can use several {dimensionLabels[kind].toLowerCase()}, so builder counts cannot be added together. API value uses the estimates in approved publications. Provider names reflect recorded data; an unspecified provider is not inferred.</p><p>Current clients group token counters by recorded UTC event dates. Older publications may use the final date of each session; the profile’s calculation details identify the method. These are community submissions, not a measure of model quality or the whole AI market.</p></details>
    <ProjectFooter /></div></main>;
}
