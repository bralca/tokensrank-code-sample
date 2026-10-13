import { TR } from '@/lib/design-tokens';

interface HistogramProps {
  values: number[];
  peakIdx?: number;
  labels?: string[];
  height?: number;
}

export function Histogram({ values, peakIdx, labels, height = 80 }: HistogramProps) {
  const max = Math.max(...values);

  const gap = values.length === 24 ? 3 : 8;

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap, height }}>
      {values.map((v, i) => {
        const h = max === 0 ? 0 : (v / max) * height;
        const isPeak = i === peakIdx;

        return (
          <div
            key={i}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-end',
              minWidth: 0,
            }}
          >
            <div
              style={{
                width: '100%',
                height: Math.max(h, 1.5),
                background: isPeak ? TR.accent : TR.borderHi,
                borderRadius: 1,
              }}
            />
            {labels && (
              <div
                className="tr-mono"
                style={{
                  fontSize: 10,
                  color: TR.textDim,
                  marginTop: 6,
                  whiteSpace: 'nowrap',
                  fontWeight: 400,
                  letterSpacing: '-0.01em',
                }}
              >
                {labels[i]}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
