import { TR, FONT_MONO } from '@/lib/design-tokens';

interface TRWordmarkProps {
  size?: number;
  accent?: string;
}

export function TRWordmark({ size = 17, accent = TR.accent }: TRWordmarkProps) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0,
        fontSize: size,
        fontWeight: 600,
        letterSpacing: '-0.02em',
        color: TR.text,
        lineHeight: 1,
        fontFamily: FONT_MONO,
      }}
    >
      <span style={{ color: accent }}>[</span>
      <span>tokens</span>
      <span style={{ color: TR.textDim }}>·</span>
      <span>rank</span>
      <span style={{ color: accent }}>]</span>
    </div>
  );
}
