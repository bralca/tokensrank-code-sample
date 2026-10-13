import { TR, FONT_MONO } from '@/lib/design-tokens';

interface LiveDotProps {
  status?: 'live' | 'stale' | 'flat';
  label: string;
}

export function LiveDot({ status = 'live', label }: LiveDotProps) {
  const colorMap = {
    live: TR.accent,
    stale: TR.down,
    flat: TR.flat,
  };

  const color = colorMap[status];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        color: TR.textMid,
        fontFamily: FONT_MONO,
      }}
    >
      <span
        className={status === 'live' ? 'tr-pulse' : ''}
        style={{
          width: 6,
          height: 6,
          background: color,
          borderRadius: '99px',
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  );
}
