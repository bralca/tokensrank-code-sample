import type { ProfileBreakdownItem } from '../../../../packages/shared/src';

type ModelsBreakdownSectionProps = {
  models_breakdown: ProfileBreakdownItem[];
  className?: string;
};

const chartColors = ['#B6FF3C', '#848E9C', '#5A6272', '#2A2A2A'];

function percentLabel(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function ModelsBreakdownSection({
  models_breakdown,
  className = '',
}: ModelsBreakdownSectionProps) {
  return (
    <section
      aria-labelledby="profile-models-heading"
      aria-label="Model token usage distribution"
      className={className}
      data-section="models-breakdown"
      data-testid="profile-section-models-breakdown"
    >
      <h2 id="profile-models-heading" className="mb-2 text-base font-semibold text-tr-text md:mb-4">
        Models
      </h2>
      <div className="flex min-w-0 flex-col gap-2 md:gap-3">
        {models_breakdown.length > 0 ? (
          models_breakdown.map((item, index) => {
            const color = chartColors[index % chartColors.length];

            return (
              <div key={item.label} className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2 text-xs md:gap-3 md:text-sm">
                  <span className="min-w-0 truncate text-tr-text">{item.label}</span>
                  <span className="shrink-0 font-mono text-tr-secondary">{percentLabel(item.percentage)}</span>
                </div>
                <div
                  className="h-3 overflow-hidden rounded-full bg-tr-bg"
                  role="img"
                  aria-label={`${item.label}: ${percentLabel(item.percentage)} of token usage`}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(0, Math.min(100, item.percentage))}%`,
                      backgroundColor: color,
                    }}
                  />
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-sm text-tr-secondary">No model usage reported for this window.</p>
        )}
      </div>
    </section>
  );
}
