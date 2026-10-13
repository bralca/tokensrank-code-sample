import Link from 'next/link';
import { Github, ChevronDown } from 'lucide-react';
import type { ProfileResponse } from '@tokensrank/shared';
import { modelLabel, formatTokens } from '../LeaderboardTable';

const toolName = (source:string) => ({claude:'Claude Code',codex:'Codex',opencode:'OpenCode'}[source] ?? source);
const date = (value:string) => new Date(value).toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});

export function EvidencePanel({profile,local}:{profile:ProfileResponse;local:boolean}) {
  const evidence=profile.evidence;
  if (!evidence) return null;
  const sources=evidence.usage?.sources ?? [];
  const coverage=evidence.usage?.attribution;
  const unpriced=[...new Set(sources.flatMap(s=>s.unpriced_models))];
  const observedDates=sources.length>0 && sources.every(s=>s.daily_basis==='event_dates');
  return <details className="evidence-panel">
    <summary><span>{local?'How your numbers are calculated':'About this usage record'}</span><span className="evidence-summary">{evidence.github_login?<><Github size={14}/> GitHub connected</>:null}{!local&&evidence.published_at?<span>Published {date(evidence.published_at)}</span>:null}<ChevronDown size={16}/></span></summary>
    <div className="evidence-content">
      <dl className="evidence-facts">
        <div><dt>Identity</dt><dd>{evidence.github_login?<a href={`https://github.com/${encodeURIComponent(evidence.github_login)}`} target="_blank" rel="noreferrer">@{evidence.github_login} ↗</a>:'GitHub not connected'}</dd><small>The connected account identifies this builder. It does not verify their token usage.</small></div>
        <div><dt>Usage record</dt><dd>{local?'Read on this device':'Submitted by the builder'}</dd><small>{sources.length?sources.map(s=>toolName(s.source)).join(' · '):'Source details were not included in this publication.'} {local?'Calculations use recorded counters and reference prices.':'Only the owner’s approved aggregates are shared.'}</small></div>
        <div><dt>Output tokens · this period</dt><dd>{evidence.output_tokens===null?'Unavailable':formatTokens(evidence.output_tokens)}</dd><small>Recorded model output, including reasoning where reported. This does not measure code quality.</small></div>
      </dl>
      <p>{observedDates?'Token activity follows recorded event dates in UTC.':'This import uses session-date summaries, or does not declare its timing method. Daily activity may be concentrated on a session’s final day.'} Each session is counted once on its last observed day. Gaps in the available files do not establish inactivity.</p>
      {sources.length>0&&<ul className="evidence-sources">{sources.map(s=><li key={s.source}><strong>{toolName(s.source)}</strong><span>{s.daily_basis==='event_dates'?'Event dates (UTC)':'Session dates'}{s.read_at?` · read ${date(s.read_at)}`:''}</span></li>)}</ul>}
      {unpriced.length>0&&<p>Prices missing from the imported history: {unpriced.join(', ')}. API value is partial for periods containing these models. Missing prices are excluded, not treated as free usage.</p>}
      {evidence.contribution?<p><strong>{evidence.contribution.commits.toLocaleString()} GitHub commits checked across {evidence.contribution.repositories} selected repositories.</strong> {evidence.contribution.checked_at?`Checked ${date(evidence.contribution.checked_at)}. `:''}This checks contributions on selected branches; it does not prove deployment, product quality, or AI authorship.</p>:!local&&<p>Code contributions were not included in this usage record.</p>}
      {coverage&&<p><strong>{coverage.linked_sessions.toLocaleString()} of {coverage.sessions.toLocaleString()} sessions have matched commit references</strong>{coverage.sessions?` (${(100*coverage.linked_sessions/coverage.sessions).toFixed(1)}%).`:'.'} Coverage of the available local record. A reference links a session to a commit; missing references do not mean no work was done.</p>}
      <p className="evidence-privacy">Prompts, conversations, file contents, local paths and individual session timelines stay on the owner’s device.</p>
    </div>
  </details>;
}

export function CategoryStandings({profile}:{profile:ProfileResponse}) {
  const standings=profile.evidence?.standings??[];
  if (!standings.length) return null;
  return <section className="category-standings" aria-label="Category positions">
    <p className="dash-eyebrow">Category positions · this period</p>
    <div>{standings.slice(0,4).map(s=><Link key={`${s.kind}:${s.slug}`} href={`/${s.kind==='model'?'models':'tools'}/${s.slug}?period=${profile.window}`}><strong>#{s.rank}</strong><span>{s.kind==='model'?modelLabel(s.key):toolName(s.key)}<small>of {s.builders.toLocaleString()} {s.builders===1?'builder':'builders'}</small></span></Link>)}</div>
    <p className="dash-footnote">Ranked by recorded token usage, with the leaderboard’s eligibility rules. More usage does not establish better results.</p>
  </section>;
}
