import type { ProfileRecentActivityItem } from '../../../../packages/shared/src';

type RecentActivitySectionProps = {
  ingestion_runs: ProfileRecentActivityItem[];
  className?: string;
};

const statusClassName: Record<ProfileRecentActivityItem['status'], string> = {
  processing: 'border-tr-secondary text-tr-secondary',
  completed: 'border-tr-success text-tr-success',
  partial: 'border-tr-warning text-tr-warning',
  failed: 'border-tr-error text-tr-error',
};

function formatFullDate(value: string): string {
  const date = new Date(value);
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');

  return `${month} ${day}, ${year} ${hour}:${minute}`;
}

function formatTimestamp(value: string): string {
  const elapsedMs = Date.now() - new Date(value).getTime();

  if (elapsedMs >= 0 && elapsedMs < 24 * 60 * 60 * 1000) {
    const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60_000));

    if (elapsedMinutes < 60) {
      return `${elapsedMinutes}m ago`;
    }

    return `${Math.round(elapsedMinutes / 60)}h ago`;
  }

  return formatFullDate(value);
}

export function RecentActivitySection({
  ingestion_runs,
  className = '',
}: RecentActivitySectionProps) {
  const sortedRuns = [...ingestion_runs]
    .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
    .slice(0, 10);

  return (
    <section
      aria-labelledby="profile-recent-activity-heading"
      className={className}
      data-section="recent-activity"
      data-testid="profile-section-recent-activity"
    >
      <h2 id="profile-recent-activity-heading" className="mb-2 text-base font-semibold text-tr-text md:mb-4">
        Recent activity
      </h2>
      <div className="flex flex-col divide-y divide-tr-border">
        {sortedRuns.length > 0 ? (
          sortedRuns.map((run) => (
            <article
              key={run.ingestion_run_id}
              className="flex min-w-0 flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between md:gap-4"
            >
              <div className="min-w-0">
                <p className="break-words font-mono text-sm text-tr-text">{formatTimestamp(run.created_at)}</p>
                <p className="mt-1 block text-sm text-tr-secondary md:hidden">
                  {run.accepted_count} accepted · {run.rejected_count} rejected · {run.deduped_count} deduped
                </p>
              </div>
              <div className="flex shrink-0 items-start justify-between gap-2 md:items-center md:gap-3">
                <dl className="hidden grid-cols-3 gap-3 text-right text-xs md:grid">
                  <div>
                    <dt className="text-tr-secondary">Accepted</dt>
                    <dd className="font-mono text-tr-text">{run.accepted_count}</dd>
                  </div>
                  <div>
                    <dt className="text-tr-secondary">Rejected</dt>
                    <dd className="font-mono text-tr-text">{run.rejected_count}</dd>
                  </div>
                  <div>
                    <dt className="text-tr-secondary">Deduped</dt>
                    <dd className="font-mono text-tr-text">{run.deduped_count}</dd>
                  </div>
                </dl>
                <span
                  className={[
                    'rounded-full border px-2 py-1 text-xs font-medium capitalize',
                    statusClassName[run.status],
                  ].join(' ')}
                >
                  {run.status}
                </span>
              </div>
            </article>
          ))
        ) : (
          <p className="py-3 text-sm text-tr-secondary">No ingestion runs reported yet.</p>
        )}
      </div>
    </section>
  );
}
