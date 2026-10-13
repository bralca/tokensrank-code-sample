type HeadlinePairSectionProps = {
  rank: number | null;
  cost_usd_total: number;
  className?: string;
};

function formatRank(rank: number | null): string {
  return rank ? `#${rank}` : 'Unranked';
}

function formatCost(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(Math.max(0, value));
}

export function HeadlinePairSection({
  rank,
  cost_usd_total,
  className = '',
}: HeadlinePairSectionProps) {
  const isHighCost = cost_usd_total > 1_000;

  return (
    <section
      aria-labelledby="profile-headline-heading"
      className={className}
      data-section="headline-pair"
      data-testid="profile-section-headline-pair"
    >
      <h2 id="profile-headline-heading" className="sr-only">
        Rank and cost
      </h2>
      <div className="grid grid-cols-1 gap-2 text-center md:grid-cols-2 md:gap-4">
        <div className="rounded-lg border border-tr-border bg-tr-bg p-2 md:p-5">
          <p className="font-mono text-4xl font-bold leading-none text-tr-text md:text-[48px]">
            {formatRank(rank)}
          </p>
          <p className="mt-3 text-xs font-medium uppercase text-tr-secondary">
            Rank
          </p>
        </div>
        <div className="rounded-lg border border-tr-border bg-tr-bg p-2 md:p-5">
          <p
            className={[
              'break-words font-mono text-2xl font-semibold leading-none md:text-[32px]',
              isHighCost ? 'text-tr-accent' : 'text-tr-text',
            ].join(' ')}
          >
            {formatCost(cost_usd_total)}
          </p>
          <p className="mt-3 text-xs font-medium uppercase text-tr-secondary">
            Cost
          </p>
        </div>
      </div>
    </section>
  );
}
