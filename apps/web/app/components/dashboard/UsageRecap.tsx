'use client';

import { ArrowDown, Layers3, LockKeyhole } from 'lucide-react';
import type { UsageRecap as Recap } from '@tokensrank/shared';
import { modelLabel, formatTokens } from '../LeaderboardTable';
import { PublicPresence } from './PublicPresence';

const dayLabel = (value: string, weekday = false) => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', weekday
  ? { weekday: 'short', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });
const percentage = (value: number) => `${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}`;
const reasons: Record<Recap['comparison'], string> = {
  ready: 'No usage recorded in the previous 7 days.',
  no_data: 'Import your usage to build a recent overview.',
  short_history: 'Not enough earlier records for a comparison yet.',
  legacy_dates: 'Refresh your files to calculate usage by event date.',
  stale: 'Refresh your files to compare the latest complete days.',
};

export function UsageRecap({ recap }: { recap: Recap }) {
  const dated = recap.comparison !== 'legacy_dates';
  const comparable = recap.comparison === 'ready';
  const maximum = Math.max(1, ...recap.current.days.map(d => d.tokens), ...(comparable ? recap.previous.days.map(d => d.tokens) : []));
  const visibleModels = recap.models.slice(0, 3);
  return <div className="usage-recap">
    <div className="recap-heading">
      <h2>Recently, on your machine</h2>
      <span><LockKeyhole size={14} aria-hidden="true"/> Private overview</span>
    </div>
    <div className="recap-grid">
      <section className="recap-week" aria-label="Recent usage comparison">
        <div className="recap-card-heading">
          <h3>Last 7 complete days</h3>
          <span>{dayLabel(recap.current.start)} – {dayLabel(recap.current.end)} · UTC</span>
        </div>
        <div className="recap-week-body">
          <div className="recap-total">
            <strong>{dated ? formatTokens(recap.current.tokens) : '—'}</strong>
            <span>tokens recorded</span>
            {recap.change_pct !== null ? <p className="recap-change"><b>{percentage(recap.change_pct)} {recap.change_pct > 0 ? 'more' : recap.change_pct < 0 ? 'less' : 'change'}</b><span>vs {formatTokens(recap.previous.tokens)} in the previous 7 days</span></p>
              : <p className="recap-comparison-note">{reasons[recap.comparison]}</p>}
          </div>
          <div className="recap-chart">
            {dated ? <>
              <div className="recap-bars" role="img" aria-label="Recorded tokens by day; exact values in Daily comparison below">
                {recap.current.days.map((d, i) => <div className="recap-bar-day" key={d.date} title={`${dayLabel(d.date)}: ${d.tokens.toLocaleString('en-US')} tokens${comparable ? `; ${dayLabel(recap.previous.days[i].date)}: ${recap.previous.days[i].tokens.toLocaleString('en-US')}` : ''}`}>
                  <div className="recap-bar-pair">
                    {comparable && <i className="recap-bar-prior" style={{ height: `${recap.previous.days[i].tokens / maximum * 100}%` }}/>}<i className="recap-bar-current" style={{ height: `${d.tokens / maximum * 100}%` }}/>
                  </div><span>{dayLabel(d.date, true)}</span>
                </div>)}
              </div>
              <div className="recap-legend"><span><i/> Latest 7 days</span>{comparable && <span><i/> Previous 7 days</span>}</div>
            </> : <p className="recap-empty">Daily comparison unavailable for this import.</p>}
          </div>
        </div>
        {dated && <div className="recap-week-footer">
          <span><strong>{formatTokens(recap.current.output_tokens)}</strong> output tokens</span>
          <span><strong>{recap.current.recorded_days} / 7</strong> days with records</span>
          <details className="recap-daily-details"><summary>Daily comparison</summary><div>
            <table><caption>Recorded tokens · UTC dates</caption><thead><tr><th>Latest</th><th>Tokens</th>{comparable && <><th>Previous</th><th>Tokens</th></>}</tr></thead>
              <tbody>{recap.current.days.map((d, i) => <tr key={d.date}><td>{dayLabel(d.date)}</td><td>{d.tokens.toLocaleString('en-US')}</td>{comparable && <><td>{dayLabel(recap.previous.days[i].date)}</td><td>{recap.previous.days[i].tokens.toLocaleString('en-US')}</td></>}</tr>)}</tbody></table>
          </div></details>
        </div>}
      </section>
      <section className="recap-models" aria-label="Recent model mix">
        <div className="recap-card-heading"><h3>Your model mix</h3><Layers3 size={18} aria-hidden="true"/></div>
        <p>Share of tokens in the latest 7 complete days.</p>
        {dated && visibleModels.length > 0 ? <ol>{visibleModels.map(m => <li key={m.model}>
          <div className="recap-model-label"><span title={m.model}>{modelLabel(m.model)}</span><strong>{percentage(m.share * 100)}</strong></div>
          <div className="recap-model-meter" aria-hidden="true"><span style={{ width: `${m.share * 100}%` }}/>{m.previous_share !== null && <i title="Previous share" style={{ left: `${m.previous_share * 100}%` }}/>}</div>
          <div className="recap-model-meta"><span>{formatTokens(m.tokens)} tokens</span><span>{m.change_points !== null ? `${signed(m.change_points)} pp vs previous 7 days` : 'Earlier share unavailable'}</span></div>
        </li>)}</ol> : <p className="recap-empty">{dated ? 'Models will appear when usage is recorded in this period.' : 'Event dates are needed to compare model choices.'}</p>}
        {dated && visibleModels.length > 0 && <small>{recap.models.length > 3 ? `Showing 3 of ${recap.models.length} models across both periods. ` : ''}{comparable && recap.previous.tokens > 0 ? 'The marker shows the previous share. pp = percentage points.' : 'Earlier shares appear once both periods can be compared.'}</small>}
      </section>
    </div>
    <p className="recap-scope">Calculated from available local records. Today is excluded; missing records do not establish inactivity.{recap.read_at ? ` All sources read through ${dayLabel(recap.read_at.slice(0, 10))}.` : ''}</p>
    <PublicPresence localTokens={recap.local_tokens_all_time} refreshKey={`${recap.read_at}:${recap.local_tokens_all_time}`}/>
    <a className="recap-history-link" href="#usage-history">Explore your history <ArrowDown size={15} aria-hidden="true"/></a>
  </div>;
}
