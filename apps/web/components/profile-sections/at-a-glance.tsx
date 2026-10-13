type AtAGlanceSectionProps = {
  total_tokens: number;
  sessions_count: number;
  days_active: number;
  avg_tokens_per_session: number;
  className?: string;
};

type StatItem = {
  label: string;
  value: string;
};

function formatTokens(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));
  const formats = [
    { value: 1_000_000_000, suffix: 'B' },
    { value: 1_000_000, suffix: 'M' },
    { value: 1_000, suffix: 'K' },
  ] as const;

  for (const format of formats) {
    if (normalized >= format.value) {
      const amount = normalized / format.value;
      return `${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1)}${format.suffix}`;
    }
  }

  return String(normalized);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(Math.max(0, Math.trunc(value)));
}

export function AtAGlanceSection({
  total_tokens,
  sessions_count,
  days_active,
  avg_tokens_per_session,
  className = '',
}: AtAGlanceSectionProps) {
  const stats: StatItem[] = [
    { label: 'Token usage', value: formatTokens(total_tokens) },
    { label: 'Sessions', value: formatInteger(sessions_count) },
    { label: 'Days active', value: formatInteger(days_active) },
    { label: 'Avg/session', value: formatTokens(avg_tokens_per_session) },
  ];

  return (
    <section
      aria-labelledby="profile-at-a-glance-heading"
      className={className}
      data-section="at-a-glance"
      data-testid="profile-section-at-a-glance"
    >
      <h2 id="profile-at-a-glance-heading" className="mb-2 text-base font-semibold text-tr-text md:mb-4">
        At a glance
      </h2>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-4 lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="min-h-20 rounded-lg border border-tr-accent bg-[#0B0E11] p-2 md:p-4"
          >
            <p className="break-words font-mono text-2xl font-bold leading-tight text-tr-text">
              {stat.value}
            </p>
            <p className="mt-2 text-xs font-medium uppercase text-tr-secondary">
              {stat.label}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
