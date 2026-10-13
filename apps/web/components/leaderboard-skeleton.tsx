import { LoadingSkeleton } from './loading-skeleton';

export function LeaderboardSkeleton() {
  return <section className="dash-community-columns" aria-label="Loading leaderboard" aria-busy="true" data-testid="leaderboard-skeleton">
    <div className="dash-community-main dash-board-scroll" aria-hidden="true">
      <table className="dash-board-table"><thead><tr>{['Rank', 'Builder', 'API value', 'Tokens', 'Sessions', 'Active days'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{[1, 2, 3].map(i => <tr key={i} data-rank={i}>
          <td><LoadingSkeleton className="h-4 w-5"/></td>
          <td className="dash-board-builder"><div className="dash-board-person"><LoadingSkeleton className="h-12 w-12" rounded="full"/><div><LoadingSkeleton className="h-5 w-32"/><LoadingSkeleton className="mt-3 h-3 w-24"/></div></div></td>
          {[0, 1, 2, 3].map(metric => <td key={metric}><LoadingSkeleton className="ml-auto h-5 w-16"/></td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="dash-community-side"><LoadingSkeleton className="h-60 w-full" rounded="lg" /></div>
  </section>;
}
