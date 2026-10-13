export type LiveDotVariant = 'pulse' | 'static';

export interface LiveDotProps {
  variant?: LiveDotVariant;
  label?: string;
  ariaLabel?: string;
  className?: string;
}

const ACID_LIME = '#B6FF3C';
const LABEL_COLOR = '#9A9A9A';

function classNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export default function LiveDot({
  variant = 'pulse',
  label,
  ariaLabel,
  className,
}: LiveDotProps) {
  const statusLabel = ariaLabel ?? label ?? (variant === 'pulse' ? 'Waiting for live activity' : 'Live status');

  return (
    <span
      aria-label={statusLabel}
      className={classNames('inline-flex items-center gap-2 font-mono text-[11px] leading-none', className)}
      data-testid="live-dot"
      role="status"
      style={{ color: LABEL_COLOR, fontFeatureSettings: "'tnum', 'zero', 'ss01'" }}
    >
      <span
        aria-hidden="true"
        className={classNames('inline-block h-1 w-1 rounded-full', variant === 'pulse' && 'tr-live-dot-pulse')}
        data-variant={variant}
        style={{ backgroundColor: ACID_LIME }}
      />
      {label ? <span>{label}</span> : null}
    </span>
  );
}
