'use client';

import { ResponsiveLine } from '@nivo/line';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { nivoTheme } from '@/lib/nivo-theme';
import { ChartHydrationSkeleton } from './ChartHydrationSkeleton';
import { dateLabelDaysAgo, formatTokens } from './utils';

interface LiveAreaChartProps {
  /** Oldest→newest daily values; the chart plots their running cumulative sum. */
  daily: number[];
  height?: number;
}

/** Interactive cumulative-tokens area chart with a date x-axis, compact y-axis,
 * crosshair, and a hover tooltip showing the exact day + running total. */
export function LiveAreaChart({ daily, height = 240 }: LiveAreaChartProps) {
  const n = daily.length;
  let cum = 0;
  const points = daily.map((value, i) => {
    cum += value || 0;
    return { x: i, y: cum, daysAgo: n - 1 - i };
  });

  // ~6 evenly spaced date ticks across the window.
  const step = Math.max(1, Math.round(n / 6));
  const tickValues = points.filter((_, i) => i % step === 0 || i === n - 1).map((p) => p.x);
  const resetKey = `${n}:${cum}`;

  return (
    <ChartHydrationSkeleton height={height} resetKey={resetKey} variant="area">
      <ResponsiveLine
        data={[{ id: 'cumulative tokens', data: points }]}
        theme={nivoTheme}
        margin={{ top: 16, right: 24, bottom: 36, left: 60 }}
        xScale={{ type: 'linear', min: 0, max: n - 1 }}
        yScale={{ type: 'linear', min: 0, max: 'auto' }}
        curve="monotoneX"
        enableArea
        areaOpacity={0.14}
        colors={[TR.accent]}
        lineWidth={2}
        enablePoints={false}
        enableGridX={false}
        gridYValues={4}
        axisLeft={{ tickSize: 0, tickPadding: 10, tickValues: 4, format: (v) => formatTokens(Number(v)) }}
        axisBottom={{
          tickSize: 0,
          tickPadding: 10,
          tickValues,
          format: (v) => dateLabelDaysAgo(n - 1 - Number(v)),
        }}
        enableSlices="x"
        useMesh
        sliceTooltip={({ slice }) => {
          const point = slice.points[0];
          const daysAgo = (point?.data as { daysAgo?: number })?.daysAgo ?? 0;
          return (
            <div
              style={{
                background: TR.bgSoft,
                border: `1px solid ${TR.borderHi}`,
                borderRadius: 8,
                padding: '8px 12px',
                fontFamily: FONT_MONO,
                fontSize: 12,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              }}
            >
              <div style={{ color: TR.textDim, fontSize: 10.5, marginBottom: 4 }}>
                {dateLabelDaysAgo(daysAgo)}
              </div>
              <div style={{ color: TR.accent, fontWeight: 600 }}>
                {formatTokens(Number(point?.data.yFormatted ?? 0))} tokens total
              </div>
            </div>
          );
        }}
      />
    </ChartHydrationSkeleton>
  );
}
