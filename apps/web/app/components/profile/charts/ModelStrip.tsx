'use client';

import { useMemo, useState } from 'react';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { getModelColor, providerLogo } from '@/lib/nivo-theme';
import { dateLabelDaysAgo } from './utils';

interface ModelStripProps {
  /** Oldest→newest dominant model per day ('' = no activity). */
  dominantModelPer90d: string[];
}

/** A categorical day strip colored by the model that led each day, with a live
 * hover readout and a color legend. Answers "which model when". */
export function ModelStrip({ dominantModelPer90d }: ModelStripProps) {
  const n = dominantModelPer90d.length;
  const [hover, setHover] = useState<number | null>(null);

  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of dominantModelPer90d) {
      if (model) counts.set(model, (counts.get(model) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([model, days]) => ({ model, days, color: getModelColor(model) }));
  }, [dominantModelPer90d]);

  const hovered = hover !== null ? dominantModelPer90d[hover] : null;
  // Long ranges (full history) pack many cells — tighten the gap so they fit.
  const gap = n > 140 ? 1 : n > 90 ? 2 : 3;

  return (
    <div>
      {/* Live readout */}
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 12,
          color: hovered ? TR.text : TR.textDim,
          marginBottom: 12,
          height: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {hover !== null && hovered ? (
          <>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: getModelColor(hovered) }} />
            <span style={{ color: TR.textDim }}>{dateLabelDaysAgo(n - 1 - hover)}</span>
            <span style={{ color: TR.text }}>{hovered}</span>
          </>
        ) : (
          'Hover a day to see which model led it.'
        )}
      </div>

      {/* Day cells */}
      <div style={{ display: 'flex', gap, alignItems: 'center' }}>
        {dominantModelPer90d.map((model, index) => (
          <div
            key={index}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover((h) => (h === index ? null : h))}
            style={{
              flex: 1,
              minWidth: 0,
              height: 40,
              borderRadius: 2,
              background: model ? getModelColor(model) : TR.bgRow,
              boxShadow: hover === index ? `0 0 0 1px ${TR.text}` : 'none',
              cursor: 'default',
              transition: 'box-shadow 100ms ease',
            }}
          />
        ))}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: 16 }}>
        {legend.map(({ model, days, color }) => {
          const logo = providerLogo(model);
          return (
          <div key={model} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: color }} />
            {logo && <img src={logo} alt="" width={13} height={13} style={{ borderRadius: 2 }} />}
            <span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: TR.textMid }}>{model}</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: TR.textDim }}>{days}d</span>
          </div>
          );
        })}
      </div>
    </div>
  );
}
