import type { ReactNode } from 'react';

export type StatCardVariant = 'default' | 'accent' | 'success' | 'warning';

export interface StatCardProps {
  label: string;
  value: string | number;
  unit?: string;
  trend?: ReactNode;
  icon?: ReactNode;
  variant?: StatCardVariant;
  ariaLabel?: string;
  className?: string;
}

const VARIANT_COLORS: Record<StatCardVariant, string> = {
  default: '#2A2F38',
  accent: '#B6FF3C',
  success: '#00D084',
  warning: '#FFB020',
};

function classNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export default function StatCard({
  label,
  value,
  unit,
  trend,
  icon,
  variant = 'default',
  ariaLabel,
  className,
}: StatCardProps) {
  const variantColor = VARIANT_COLORS[variant];

  return (
    <section
      aria-label={ariaLabel ?? `${label}: ${value}${unit ? ` ${unit}` : ''}`}
      className={classNames(
        'flex min-h-[92px] w-full flex-col rounded-lg bg-tr-bg-soft p-4 md:basis-[240px]',
        className,
      )}
      data-testid="stat-card"
      data-variant={variant}
      style={{
        border: `1px solid ${variantColor}`,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className="font-mono uppercase leading-none tracking-[0.08em]"
          style={{
            color: '#5A6272',
            fontSize: 12,
          }}
        >
          {label}
        </div>
        {icon ? (
          <div aria-hidden="true" className="shrink-0" style={{ color: variantColor }}>
            {icon}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex min-w-0 items-baseline gap-1.5">
        <div
          className="truncate font-mono leading-none"
          style={{
            color: '#FFFFFF',
            fontFeatureSettings: "'tnum', 'zero', 'ss01'",
            fontSize: 24,
            fontWeight: 600,
          }}
        >
          {value}
        </div>
        {unit ? <div className="font-mono text-xs text-tr-secondary">{unit}</div> : null}
      </div>

      {trend ? <div className="mt-auto pt-3 text-xs text-tr-secondary">{trend}</div> : null}
    </section>
  );
}
