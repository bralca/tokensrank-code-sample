import { TR, FONT_MONO } from '@/lib/design-tokens';

interface DeltaProps {
  value?: number | null;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

const sizeMap = {
  sm: { fontSize: 12, fontWeight: 400 },
  md: { fontSize: 14, fontWeight: 500 },
  lg: { fontSize: 16, fontWeight: 500 },
};

export function Delta({ value, size = 'md', showLabel = false }: DeltaProps) {
  if (value === 0 || value == null) {
    return (
      <span
        style={{
          fontFamily: FONT_MONO,
          color: TR.flat,
          fontSize: sizeMap[size].fontSize,
        }}
      >
        —
      </span>
    );
  }

  const up = value > 0;
  const color = up ? TR.up : TR.down;
  const arrow = up ? '↑' : '↓';

  return (
    <span
      style={{
        fontFamily: FONT_MONO,
        color,
        fontSize: sizeMap[size].fontSize,
        fontWeight: sizeMap[size].fontWeight,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
      }}
    >
      {arrow}
      {Math.abs(value)}
      {showLabel && <span style={{ color: TR.textDim, marginLeft: 6 }}>this month</span>}
    </span>
  );
}
