import type { ProfileParallelismBucket } from '../../../../packages/shared/src';

type ParallelismDistSectionProps = {
  concurrent_sessions_dist: ProfileParallelismBucket[];
  className?: string;
};

function percentLabel(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

function normalizeLabel(label: string): string {
  if (/^1\b/u.test(label)) {
    return '1';
  }

  if (/^2\b/u.test(label)) {
    return '2';
  }

  if (/^3\b/u.test(label)) {
    return '3+';
  }

  return label;
}

export function ParallelismDistSection({
  concurrent_sessions_dist,
  className = '',
}: ParallelismDistSectionProps) {
  const peak = Math.max(0, ...concurrent_sessions_dist.map((bucket) => bucket.percentage));

  return (
    <section
      aria-labelledby="profile-parallelism-heading"
      aria-label="Concurrent sessions distribution"
      className={className}
      data-section="parallelism-dist"
      data-testid="profile-section-parallelism-dist"
    >
      <h2 id="profile-parallelism-heading" className="mb-2 text-base font-semibold text-tr-text md:mb-4">
        Parallelism
      </h2>
      <div className="grid min-h-0 grid-cols-1 items-stretch gap-2 md:min-h-48 md:grid-cols-2 md:items-end md:gap-4 lg:grid-cols-3">
        {concurrent_sessions_dist.length > 0 ? (
          concurrent_sessions_dist.map((bucket) => {
            const isPeak = bucket.percentage === peak && peak > 0;
            const height = `${Math.max(4, Math.min(100, bucket.percentage))}%`;

            return (
              <div
                key={bucket.label}
                className="flex h-auto flex-col items-stretch justify-end gap-2 md:h-48 md:items-center"
              >
                <p className="font-mono text-sm text-tr-text">{percentLabel(bucket.percentage)}</p>
                <div className="flex h-8 w-full items-end rounded-lg bg-tr-bg p-2 md:h-32">
                  <div
                    className={[
                      'h-full w-full rounded-md md:h-auto',
                      isPeak ? 'bg-tr-accent' : 'bg-tr-secondary',
                    ].join(' ')}
                    style={{
                      height,
                      width: '100%',
                    }}
                    role="img"
                    aria-label={`${bucket.label}: ${percentLabel(bucket.percentage)}`}
                  />
                </div>
                <p className="text-left text-sm text-tr-secondary md:text-center">
                  {normalizeLabel(bucket.label)}
                </p>
              </div>
            );
          })
        ) : (
          <p className="col-span-full text-sm text-tr-secondary">
            No parallelism data reported for this window.
          </p>
        )}
      </div>
    </section>
  );
}
