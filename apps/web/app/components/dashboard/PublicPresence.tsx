'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Globe2 } from 'lucide-react';
import { PublicPresenceSchema, type PublicPresence as Presence } from '@tokensrank/shared';
import { apiFetch } from '../../lib/api';
import { formatTokens, modelLabel } from '../LeaderboardTable';

const toolName = (key: string) => ({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }[key] ?? key);
const count = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'builder' : 'builders'}`;

export function PublicPresence({ localTokens, refreshKey }: { localTokens: number; refreshKey: string }) {
  const [presence, setPresence] = useState<Presence | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPresence(null);
    apiFetch<{ data: unknown }>('/local/publish/presence', { signal: controller.signal, cache: 'no-store' })
      .then(response => { if (!controller.signal.aborted) setPresence(PublicPresenceSchema.parse(response.data)); })
      .catch(() => { if (!controller.signal.aborted) setPresence({ status: 'unavailable' }); });
    return () => controller.abort();
  }, [refreshKey, retry]);
  return <PublicPresenceView presence={presence} localTokens={localTokens} onRetry={() => setRetry(n => n + 1)}/>;
}

export function PublicPresenceView({ presence, localTokens, onRetry }: { presence: Presence | null; localTokens: number; onRetry: () => void }) {
  const published = presence?.status === 'available' ? presence : null;
  const difference = published ? localTokens - published.tokens : 0;
  return <section className="recap-presence" aria-label="Your public presence" aria-busy={presence === null}>
    <div className="recap-presence-header">
      <h2><Globe2 size={18} aria-hidden="true"/> On the leaderboard</h2>
      {published ? <a href={published.profile_url} target="_blank" rel="noreferrer">@{published.handle} <ArrowUpRight size={15}/></a> : <span>Optional sharing</span>}
    </div>
    {published ? <>
      <div className="recap-presence-body">
        <div className="recap-positions">
          <div className="recap-position"><span>Overall · all time</span><strong>{published.rank ? `#${published.rank}` : 'Not ranked'}</strong><small>{published.rank ? published.builders !== null ? `of ${count(published.builders)}` : 'Participant count unavailable' : 'No eligible position right now'}</small></div>
          {published.standings.slice(0, 2).map(s => <a className="recap-position" key={`${s.kind}:${s.key}`} href={new URL(`/${s.kind === 'model' ? 'models' : 'tools'}/${encodeURIComponent(s.slug)}?period=all`, published.profile_url).href} target="_blank" rel="noreferrer">
            <span>{s.kind === 'model' ? modelLabel(s.key) : toolName(s.key)} <ArrowUpRight size={13}/></span><strong>#{s.rank}</strong><small>of {count(s.builders)}</small>
          </a>)}
          <p className="recap-rank-note">Overall rank compares estimated API value. Model and tool positions compare tokens.</p>
        </div>
        <div className="recap-receipt">
          <div><span>On your device</span><strong title={localTokens.toLocaleString('en-US')}>{formatTokens(localTokens)}</strong></div>
          <div><span>Published snapshot</span><strong title={published.tokens.toLocaleString('en-US')}>{formatTokens(published.tokens)}</strong></div>
          <p>{difference > 0 ? <><b>{formatTokens(difference)} more tokens</b> in your local total.</> : difference < 0 ? <><b>{formatTokens(-difference)} fewer tokens</b> in your local total.</> : 'Your local and published token totals match.'} {published.published_at && <span>Published {new Date(published.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.</span>}</p>
          <Link href="/local/publish" className="dash-text-button">Review an update <ArrowUpRight size={15}/></Link>
        </div>
      </div>
      <div className="recap-presence-footer">This reads your public profile. Local changes stay private until you approve a publishing receipt.</div>
    </> : <div className="recap-presence-empty" role="status">
      <div><strong>{!presence ? 'Checking your public profile…' : presence.status === 'unavailable' ? 'Public profile temporarily unavailable' : presence.status === 'unpublished' ? 'Your first publication is still ahead' : 'Your usage is private by default'}</strong>
        <p>{!presence ? 'Reading only what is already public.' : presence.status === 'unavailable' ? 'Your local overview still works. Try checking the leaderboard again.' : 'Review an aggregate receipt to join the rankings. Your conversations and source files stay here.'}</p></div>
      {presence?.status === 'unavailable' ? <button className="dash-button" onClick={onRetry}>Try again</button> : presence && <Link href="/local/publish" className="dash-button">{presence.status === 'unpublished' ? 'Review publishing' : 'Connect your account'} <ArrowUpRight size={15}/></Link>}
    </div>}
  </section>;
}
