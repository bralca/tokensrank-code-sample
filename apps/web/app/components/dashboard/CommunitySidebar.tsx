import Link from 'next/link';
import type { LeaderboardRow, LeaderboardPeriod, LeaderboardScope } from '../../../../../packages/shared/src/schemas/leaderboard';
import { loadUsageCatalog, dimensionLabel, dimensionPath } from '../../lib/explorer';
import { formatTokens, formatCost } from '../LeaderboardTable';

export async function CommunitySidebar({ recent, period, scope, unavailable = false }: {
  rows: LeaderboardRow[]; recent: LeaderboardRow[]; period: LeaderboardPeriod; scope: LeaderboardScope; unavailable?: boolean;
}) {
  const models = await loadUsageCatalog('model',period).then(rows=>rows.slice(0,5)).catch(()=>null);
  return <aside className="dash-community-side" aria-label="Community highlights">
    <section className="dash-side-section">
      <h2>Most-used models</h2>
      <p className="dash-side-note">By tokens across the community in this period.</p>
      {models?.length ? <ol className="dash-side-list">
        {models.map((model, i) => <li key={model.key}>
          <span>#{i + 1}</span><Link href={`${dimensionPath('model',model.slug)}?period=${period}`} title={model.key}>{dimensionLabel('model',model.key)}</Link><strong>{formatTokens(model.tokens)}</strong>
        </li>)}
      </ol> : <p className="dash-side-note">{models===null?'Model totals are temporarily unavailable.':'No published model usage for this period.'}</p>}
      <Link className="dash-side-link" href={`/models?period=${period}`}>Explore models ↗</Link>
    </section>
    <section className="dash-side-section">
      <h2>Today (UTC)</h2>
      <p className="dash-side-note">{{ all: 'All tools', claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }[scope]} · by estimated API value</p>
      {recent.length ? <ol className="dash-side-list">
        {recent.map(row => <li key={row.handle}>
          <span>#{row.rank}</span><Link href={`/u/${row.handle}`} title={row.display_name || row.handle}>{row.display_name || row.handle}</Link><strong>{formatCost(row.cost_usd_total)}</strong>
        </li>)}
      </ol> : <p className="dash-side-note">{unavailable ? 'Recent rankings are unavailable.' : 'No published activity today.'}</p>}
      <Link className="dash-side-link" href={`/?period=24h&scope=${scope}`}>View today’s rankings ↗</Link>
    </section>
  </aside>;
}
