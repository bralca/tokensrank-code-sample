import type { ProfileToolBreakdownItem } from '../../../../packages/shared/src';

type ToolsBreakdownSectionProps = {
  sources_breakdown: ProfileToolBreakdownItem[];
  className?: string;
};

const secondaryColors = ['#848E9C', '#5A6272', '#2A2A2A'];

function sourceLabel(item: ProfileToolBreakdownItem): string {
  if (item.label && item.label !== item.source) {
    return item.label;
  }

  if (item.source === 'claude') return 'Claude Code';
  if (item.source === 'opencode') return 'OpenCode';
  return 'Codex';
}

function percentLabel(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function ToolsBreakdownSection({
  sources_breakdown,
  className = '',
}: ToolsBreakdownSectionProps) {
  return (
    <section
      aria-labelledby="profile-tools-heading"
      aria-label="Tool token usage distribution"
      className={className}
      data-section="tools-breakdown"
      data-testid="profile-section-tools-breakdown"
    >
      <h2 id="profile-tools-heading" className="mb-2 text-base font-semibold text-tr-text md:mb-4">
        Tools
      </h2>
      <div className="flex min-w-0 flex-col gap-2 md:gap-3">
        {sources_breakdown.length > 0 ? (
          sources_breakdown.map((item, index) => {
            const label = sourceLabel(item);
            const color = index === 0 ? '#B6FF3C' : secondaryColors[(index - 1) % secondaryColors.length];

            return (
              <div key={`${item.source}-${label}`} className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2 text-xs md:gap-3 md:text-sm">
                  <span className="min-w-0 truncate text-tr-text">{label}</span>
                  <span className="shrink-0 font-mono text-tr-secondary">{percentLabel(item.percentage)}</span>
                </div>
                <div
                  className="h-3 overflow-hidden rounded-full bg-tr-bg"
                  role="img"
                  aria-label={`${label}: ${percentLabel(item.percentage)} of token usage`}
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
          <p className="text-sm text-tr-secondary">No tool usage reported for this window.</p>
        )}
      </div>
    </section>
  );
}
