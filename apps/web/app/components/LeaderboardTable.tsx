import Link from "next/link";
import { LeaderboardQuerySchema, type LeaderboardRow, type LeaderboardQuery, type LeaderboardSort } from "../../../../packages/shared/src/schemas/leaderboard";

import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight, BadgeCheck, Layers, Users } from "lucide-react";
import { BuilderAvatar } from './dashboard/BuilderAvatar';
import { leaderboardSortHref } from '../lib/leaderboard-navigation';

type LeaderboardTableProps = {
  rows: LeaderboardRow[];
  unavailable?: boolean;
  query?: LeaderboardQuery;
};

export function formatTokens(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));
  const formats = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "K" },
  ] as const;

  for (const format of formats) {
    if (normalized >= format.value) {
      const amount = normalized / format.value;
      return `${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1)}${format.suffix}`;
    }
  }

  return String(normalized);
}

export function formatCost(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.max(0, value));
}

export function modelLabel(model: string): string {
  return model
    .replace(/^(anthropic|openai)\//, "")
    .replace(/-20\d{6}$/, "")
    .replace(/(\d)-(\d)/g, "$1.$2")
    .replace(/-/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bGpt\b/g, "GPT");
}

const columns: Array<{ sort: LeaderboardSort; label: string; description: string }> = [
  { sort: 'cost', label: 'API value', description: 'Estimated USD at model API prices. Not actual spending; unpriced models are excluded.' },
  { sort: 'tokens', label: 'Tokens', description: 'Published input, output and cached tokens for this tool and period.' },
  { sort: 'sessions', label: 'Sessions', description: 'Sum of daily session counts. A session active on several days can count on each day.' },
  { sort: 'active_days', label: 'Active days', description: 'Distinct UTC dates with published token usage in this period.' },
];

export function LeaderboardTable({ rows, unavailable = false, query = LeaderboardQuerySchema.parse({}) }: LeaderboardTableProps) {
  return <div id="leaderboard-table" className="dash-community-main">
    {rows.length ? <>
      <p className="dash-board-scroll-hint">Scroll across to compare all metrics.</p>
      <div className="dash-board-scroll" role="region" aria-label="Sortable leaderboard" tabIndex={0}>
        <table className="dash-board-table" aria-label="Community leaderboard">
          <thead><tr>
            <th scope="col" className="dash-board-rank">Rank</th>
            <th scope="col" className="dash-board-builder">Builder</th>
            {columns.map(column => <th scope="col" key={column.sort} aria-sort={query.sort === column.sort ? query.order === 'desc' ? 'descending' : 'ascending' : 'none'}>
              <Link href={leaderboardSortHref(query, column.sort)} scroll={false} className="dash-board-sort" title={column.description}
                aria-label={`Sort by ${column.label}, ${query.sort === column.sort && query.order === 'desc' ? 'lowest first' : 'highest first'}`}>
                {column.label}
                {query.sort !== column.sort ? <ArrowUpDown size={13} aria-hidden="true"/> : query.order === 'desc' ? <ArrowDown size={14} aria-hidden="true"/> : <ArrowUp size={14} aria-hidden="true"/>}
              </Link>
            </th>)}
          </tr></thead>
          <tbody>{rows.map(row => <tr data-rank={row.rank} key={row.handle}>
            <td className="dash-board-rank"><span className="dash-entry-rank">#{row.rank}</span></td>
            <td className="dash-board-builder"><div className="dash-board-person">
              <Link href={`/u/${row.handle}`} className="dash-entry-avatar" aria-label={`${row.display_name || row.handle}'s profile`}>
                <BuilderAvatar name={row.display_name || row.handle} url={row.avatar_url} />
              </Link>
              <div className="dash-entry-identity">
                <Link className="dash-entry-name" href={`/u/${row.handle}`}>
                  <span>{row.display_name || row.handle}</span>
                  {row.mode === "script_verified" && <BadgeCheck size={16} aria-label="Usage imported from local tool records" />}
                </Link>
                <span className="dash-entry-handle">@{row.handle}</span>
                {row.top_model && <span className="dash-board-model" title={`Most-used model by tokens: ${row.top_model}`}><Layers size={12} aria-hidden="true"/>{modelLabel(row.top_model)}</span>}
              </div>
            </div></td>
            <td className={query.sort === 'cost' ? 'is-sorted' : undefined}>
              <strong>{formatCost(row.cost_usd_total)}</strong>
              {row.api_value_partial && <span className="dash-board-partial" title="Some published models have no price. This estimate excludes their usage.">Partial estimate</span>}
            </td>
            <td className={query.sort === 'tokens' ? 'is-sorted' : undefined} title={row.tokens_total.toLocaleString('en-US')}><strong>{formatTokens(row.tokens_total)}</strong></td>
            <td className={query.sort === 'sessions' ? 'is-sorted' : undefined}><strong>{row.sessions_count?.toLocaleString('en-US') ?? '—'}</strong></td>
            <td className={query.sort === 'active_days' ? 'is-sorted' : undefined}><strong>{row.active_days?.toLocaleString('en-US') ?? '—'}</strong></td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="dash-board-note">API value is an estimate in USD, not actual spending. All metrics reflect the selected tool and period.</p>
    </> : <div className="dash-empty-board">
      <Users size={30} />
      <h3>{unavailable ? "Rankings unavailable" : "No usage for this period"}</h3>
      <p>{unavailable ? "Please try again shortly." : "Try a longer period or a different tool to see more builders."}</p>
      <Link href="/join" className="dash-button primary">Share your usage <ArrowUpRight size={14}/></Link>
    </div>}
  </div>;
}
