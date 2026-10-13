'use client';

import { ResponsiveLine } from '@nivo/line';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { nivoTheme } from '@/lib/nivo-theme';
import { ChartHydrationSkeleton } from './ChartHydrationSkeleton';
import { dateLabelDaysAgo } from './utils';

/** Composite-score momentum line. `scores` is the backend trailing-30d score per
 * day (chronological, last = today); we normalize to % of the user's own peak so
 * the y-axis is readable (the score itself is unitless). */
export function ScoreOverTime({ scores, height = 260 }: { scores: number[]; height?: number }) {
  const n = scores.length;
  const peak = Math.max(1e-9, ...scores);
  const points = scores.map((s, i) => ({ x: i, y: Math.round((s / peak) * 100), daysAgo: n - 1 - i }));
  const step = Math.max(1, Math.round(n / 6));
  const tickValues = points.filter((_, i) => i % step === 0 || i === n - 1).map((p) => p.x);
  const resetKey = `${n}:${scores.reduce((total, score) => total + score, 0)}`;

  return (
    <ChartHydrationSkeleton height={height} resetKey={resetKey} variant="area">
      <ResponsiveLine
        data={[{ id: 'momentum', data: points }]}
        theme={nivoTheme}
        margin={{ top: 16, right: 24, bottom: 36, left: 52 }}
        xScale={{ type: 'linear', min: 0, max: Math.max(1, n - 1) }}
        yScale={{ type: 'linear', min: 0, max: 100 }}
        curve="monotoneX"
        enableArea
        areaOpacity={0.14}
        colors={[TR.accent]}
        lineWidth={2}
        enablePoints={false}
        enableGridX={false}
        gridYValues={[0, 50, 100]}
        axisLeft={{ tickSize: 0, tickPadding: 10, tickValues: [0, 50, 100], format: (v) => `${v}%` }}
        axisBottom={{ tickSize: 0, tickPadding: 10, tickValues, format: (v) => dateLabelDaysAgo(n - 1 - Number(v)) }}
        enableSlices="x"
        useMesh
        sliceTooltip={({ slice }) => {
          const pt = slice.points[0]?.data as { daysAgo?: number; y?: number | string } | undefined;
          if (!pt) return null;
          return (
            <div style={{ background: TR.bgSoft, border: `1px solid ${TR.borderHi}`, borderRadius: 8, padding: '8px 12px', fontFamily: FONT_MONO, fontSize: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
              <div style={{ color: TR.textDim, fontSize: 10.5, marginBottom: 4 }}>{dateLabelDaysAgo(pt.daysAgo ?? 0)}</div>
              <div style={{ color: TR.accent, fontWeight: 600 }}>{Number(pt.y)}% of peak momentum</div>
            </div>
          );
        }}
      />
    </ChartHydrationSkeleton>
  );
}
