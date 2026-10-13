import { TR } from '@/lib/design-tokens';

interface PeakSparkProps {
  values: number[];
  height?: number;
}

export function PeakSpark({ values, height = 48 }: PeakSparkProps) {
  const max = Math.max(...values);
  const peakIdx = values.indexOf(max);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height, width: '100%' }}>
      {values.map((v, i) => {
        const h = max === 0 ? 0 : (v / max) * height;

        return (
          <div
            key={i}
            style={{
              flex: 1,
              height: Math.max(h, 1),
              background: i === peakIdx ? TR.accent : TR.borderHi,
              borderRadius: 1,
            }}
          />
        );
      })}
    </div>
  );
}
