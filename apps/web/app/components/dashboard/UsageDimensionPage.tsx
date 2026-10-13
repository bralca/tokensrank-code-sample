import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { UsageDimensionKind } from '@tokensrank/shared';
import { HomepageHeader } from '../homepage/Header';
import { ProjectFooter } from './Brand';
import { BuilderAvatar } from './BuilderAvatar';
import { formatTokens, formatCost } from '../LeaderboardTable';
import { directoryPaths, dimensionLabels, dimensionLabel, dimensionPath, explorerFilters, explorerPeriods, loadUsageDimension, jsonLd } from '../../lib/explorer';
import { getSiteUrl } from '../../../lib/sitemap';

type Search = Record<string,string|string[]|undefined>;
// Editorial threshold: directories remain discoverable; tiny category boards wait for participation.
export const MIN_INDEXED_BUILDERS = 3;
export async function dimensionMetadata(kind: UsageDimensionKind, slug: string, search: Search): Promise<Metadata> {
  const {period,offset} = explorerFilters(search);
  const data = await loadUsageDimension(kind,slug,period,offset);
  if (!data?.dimension) return { title:'Usage category not found', robots:{index:false,follow:true} };
  const label = dimensionLabel(kind,data.dimension.key);
  return {
    title:`Highest ${label} token usage · TokensRank`,
    description:`Explore ${label} usage from ${data.builders} published builders: token totals, API-equivalent value and tool breakdowns.`,
    alternates:{canonical:dimensionPath(kind,slug)},
    robots:{index:data.builders>=MIN_INDEXED_BUILDERS && data.dimension.key!=='unknown' && period==='all' && offset===0,follow:true},
  };
}

export async function UsageDimensionPage({kind,slug,search}:{kind:UsageDimensionKind;slug:string;search:Search}) {
  const {period,offset} = explorerFilters(search);
  const data = await loadUsageDimension(kind,slug,period,offset);
  if (!data?.dimension) notFound();
  const label = dimensionLabel(kind,data.dimension.key);
  const path = dimensionPath(kind,slug);
  const url = getSiteUrl()+path;
  const percent = data.community_tokens ? 100*data.tokens/data.community_tokens : 0;
  const schema = { '@context':'https://schema.org', '@type':'CollectionPage', name:`Highest ${label} token usage`, url,
    mainEntity:{'@type':'ItemList', numberOfItems:data.rows.length, itemListElement:data.rows.map(row=>({
      '@type':'ListItem',position:row.rank,url:`${getSiteUrl()}/u/${row.handle}`,name:row.display_name||row.handle,
    }))}, breadcrumb:{'@type':'BreadcrumbList',itemListElement:[
      {'@type':'ListItem',position:1,name:dimensionLabels[kind],item:getSiteUrl()+directoryPaths[kind]},
      {'@type':'ListItem',position:2,name:label,item:url},
    ]} };
  return <main className="dashboard dash-market"><HomepageHeader /><div className="dash-content">
    <script type="application/ld+json" dangerouslySetInnerHTML={{__html:jsonLd(schema)}} />
    <Link className="explore-back" href={directoryPaths[kind]}>← All {dimensionLabels[kind].toLowerCase()}</Link>
    <div className="dash-page-title"><div><p className="dash-eyebrow">{kind==='model'?'Model':kind==='tool'?'Coding tool':'Recorded provider'}</p><h1>{label}</h1><p className="dash-subtitle">Highest token usage among builders who publish to TokensRank.</p>{kind==='model' && <small className="explore-id">{data.dimension.key}</small>}</div>
      <nav className="dash-periods" aria-label="Usage period">{explorerPeriods.map(([key,text])=><Link key={key} href={`${path}?period=${key}`} className={`dash-button ${period===key?'dark':''}`} aria-current={period===key?'page':undefined}>{text}</Link>)}</nav></div>
    <section className="dash-stat-grid" aria-label={`${label} community totals`}>
      <div className="dash-stat"><span>Tokens used</span><strong>{formatTokens(data.tokens)}</strong><small>Input, output and cached context</small></div>
      <div className="dash-stat"><span>Builders</span><strong>{data.builders.toLocaleString()}</strong><small>With published usage in this period</small></div>
      <div className="dash-stat"><span>Community token share</span><strong>{percent.toFixed(1)}%</strong><small>Of eligible published usage</small></div>
      <div className="dash-stat"><span>Output tokens</span><strong>{data.output_tokens===null?"—":formatTokens(data.output_tokens)}</strong><small>Includes reasoning where reported</small></div>
    </section>
    <div className="explore-detail-grid"><section><h2 className="explore-section-title">Builders using {label}</h2>
      {data.rows.length ? <ol className="dash-ranking-list" start={offset+1}>{data.rows.map(r=><li className="dash-entry" data-rank={r.rank} key={r.handle}>
        <span className="dash-entry-rank">#{r.rank}</span><Link href={`/u/${r.handle}`} className="dash-entry-avatar" aria-label={`${r.handle}'s profile`}><BuilderAvatar name={r.display_name||r.handle} url={r.avatar_url}/></Link>
        <div className="dash-entry-identity"><Link className="dash-entry-name" href={`/u/${r.handle}`}>{r.display_name||r.handle}</Link><span className="dash-entry-handle">@{r.handle}</span><span className="explore-builder-detail">{r.api_value_partial?(r.api_value>0?`${formatCost(r.api_value)} partial estimate`:'API value unavailable'):`${formatCost(r.api_value)} API value`} · {r.tools} {r.tools===1?'tool':'tools'}{kind!=='model'?` · ${r.models} models`:''}</span></div>
        <div className="dash-entry-value"><strong>{formatTokens(r.tokens)}</strong><small>{r.output_tokens===null?"tokens":`${formatTokens(r.output_tokens)} output tokens`}</small></div>
      </li>)}</ol> : <div className="dash-empty-board"><h3>No builders in this period</h3><Link href={path} className="dash-button">View all time</Link></div>}
      <nav className="explore-pagination" aria-label="Rankings pages"><span>{data.rows.length ? `${offset+1}–${offset+data.rows.length} of ${data.builders} builders`:'No results'}</span><div>{offset>0&&<Link className="dash-button" href={`${path}?period=${period}&offset=${Math.max(0,offset-50)}`}>Previous</Link>}{offset+50<data.builders&&<Link className="dash-button" href={`${path}?period=${period}&offset=${offset+50}`}>Next</Link>}</div></nav>
    </section><aside className="explore-breakdown" aria-label="Related usage">{(['model','tool','provider'] as const).filter(k=>k!==kind).map(k=><section key={k}><h2>{dimensionLabels[k]}</h2><p className="dash-side-note">Within this {kind}’s published usage</p><ol>{data.breakdown.filter(b=>b.kind===k).slice(0,8).map(b=><li key={b.slug}><Link href={`${dimensionPath(k,b.slug)}${period==='all'?'':`?period=${period}`}`}>{dimensionLabel(k,b.key)}</Link><strong>{formatTokens(b.tokens)}</strong></li>)}</ol></section>)}</aside></div>
    <details className="explore-method"><summary>What this ranking measures</summary><p>Usage intensity among participating builders. Total tokens include reused context; higher usage does not establish code quality or productivity. Rankings apply the same eligibility and trust adjustments as the main leaderboard.</p><p>Only approved aggregate publications are included. Conversations, local paths and session histories remain private. Each model ID is kept distinct, including dated versions.</p><p>Published dates: {data.first_date ?? '—'} to {data.last_date ?? '—'}. Current clients use recorded UTC event dates. Older publications may assign a session to its final date. Check the profile’s calculation details for the source method.</p></details>
    <ProjectFooter /></div></main>;
}
