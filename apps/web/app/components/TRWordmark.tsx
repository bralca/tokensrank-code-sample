export type TRWordmarkSize = 'sm' | 'md' | 'lg';

export interface TRWordmarkProps {
  size?: TRWordmarkSize;
  ariaLabel?: string;
  className?: string;
}

const WORDMARK_SIZE_PX: Record<TRWordmarkSize, number> = {
  sm: 16,
  md: 24,
  lg: 32,
};

const ACID_LIME = '#B6FF3C';
const WORDMARK_TEXT = '#FFFFFF';
const WORDMARK_DOT = '#5C5C5C';

function classNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export default function TRWordmark({
  size = 'md',
  ariaLabel = 'TokensRank',
  className,
}: TRWordmarkProps) {
  const fontSize = WORDMARK_SIZE_PX[size];

  return (
    <span
      aria-label={ariaLabel}
      className={classNames('inline-flex items-center font-mono font-semibold leading-none', className)}
      data-size={size}
      data-testid="tr-wordmark"
      role="img"
      style={{
        color: WORDMARK_TEXT,
        fontFeatureSettings: "'tnum', 'zero', 'ss01'",
        fontSize,
        fontWeight: 600,
        letterSpacing: '-0.02em',
      }}
    >
      <span aria-hidden="true" style={{ color: ACID_LIME }}>
        [
      </span>
      <span aria-hidden="true">tokens</span>
      <span aria-hidden="true" style={{ color: WORDMARK_DOT }}>
        &middot;
      </span>
      <span aria-hidden="true">rank</span>
      <span aria-hidden="true" style={{ color: ACID_LIME }}>
        ]
      </span>
    </span>
  );
}
