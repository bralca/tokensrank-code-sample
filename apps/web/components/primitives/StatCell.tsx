import { TR, FONT_MONO } from '@/lib/design-tokens';

interface StatCellProps {
  label: string;
  value: string | number;
  sub?: string;
  mono?: boolean;
  valueColor?: string;
}

export function StatCell({ label, value, sub, mono = true, valueColor }: StatCellProps) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        className="tr-mono"
        style={{
          fontSize: 10.5,
          color: TR.textMid,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          fontFamily: FONT_MONO,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        className={mono ? 'tr-num' : ''}
        style={{
          fontSize: 20,
          fontWeight: 600,
          color: valueColor || TR.text,
          marginTop: 8,
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontFamily: mono ? FONT_MONO : 'inherit',
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 12,
            color: TR.textDim,
            marginTop: 4,
            lineHeight: 1.3,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
