export interface DeltaProps {
  value: number;
  ariaLabel?: string;
  className?: string;
}

const POSITIVE_COLOR = '#B6FF3C';
const NEGATIVE_COLOR = '#EF4444';

function classNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function formatDeltaLabel(value: number): string {
  const absoluteValue = Math.abs(value);
  const signedValue = value > 0 ? `+${absoluteValue}` : `-${absoluteValue}`;
  const direction = value > 0 ? 'up' : 'down';

  return `${signedValue} ${direction}`;
}

export default function Delta({ value, ariaLabel, className }: DeltaProps) {
  if (value === 0) {
    return null;
  }

  const isPositive = value > 0;
  const glyph = isPositive ? '↑' : '↓';
  const absoluteValue = Math.abs(value);

  return (
    <span
      aria-label={ariaLabel ?? formatDeltaLabel(value)}
      className={classNames('inline-flex items-center gap-0.5 font-semibold leading-none', className)}
      data-testid="delta"
      style={{
        color: isPositive ? POSITIVE_COLOR : NEGATIVE_COLOR,
        fontFeatureSettings: "'tnum'",
        fontSize: 12,
      }}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{absoluteValue}</span>
    </span>
  );
}
