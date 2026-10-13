import { TR, FONT_MONO } from '@/lib/design-tokens';

interface SectionHeaderProps {
  /** Plain-English eyebrow, e.g. "ACTIVITY" — no L0/L1 jargon. */
  eyebrow: string;
  title: string;
  subtitle: string;
  /** Right-aligned meta, e.g. "Updated 2m ago · last 90 days". */
  meta?: string;
}

export function SectionHeader({ eyebrow, title, subtitle, meta }: SectionHeaderProps) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: TR.accent,
            textTransform: 'uppercase',
            letterSpacing: '0.16em',
            fontFamily: FONT_MONO,
          }}
        >
          {eyebrow}
        </span>
        {meta && (
          <span style={{ fontSize: 11, color: TR.textDim, fontFamily: FONT_MONO, letterSpacing: '0.04em' }}>
            {meta}
          </span>
        )}
      </div>
      <h2
        style={{
          fontSize: 32,
          fontWeight: 400,
          color: TR.text,
          margin: 0,
          fontFamily: '"New York", "Times New Roman", Georgia, serif',
          lineHeight: 1.12,
          letterSpacing: '-0.01em',
        }}
      >
        {title}
      </h2>
      <p
        style={{
          fontSize: 13.5,
          color: TR.textMid,
          margin: '10px 0 0 0',
          lineHeight: 1.5,
          maxWidth: 660,
          fontFamily: FONT_MONO,
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}
