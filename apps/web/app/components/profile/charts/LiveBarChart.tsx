'use client';

import { ResponsiveBar } from '@nivo/bar';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { nivoTheme } from '@/lib/nivo-theme';
import { ChartHydrationSkeleton } from './ChartHydrationSkeleton';

export interface BarDatum {
  /** Unique key used for the x index. */
  id: string;
  value: number;
  /** Optional per-bar color (e.g. intensity ramp). Defaults to lime accent. */
  color?: string;
  /** Tooltip title line. */
  label: string;
  /** Tooltip secondary line, e.g. "12,300 tokens". */
  note: string;
}

interface LiveBarChartProps {
  data: BarDatum[];
  height?: number;
  /** Which x ids to label; omit to label every bar. */
  tickValues?: string[];
  tickRotation?: number;
  padding?: number;
  /** Format the bottom-axis tick (defaults to the id). */
  axisFormat?: (id: string) => string;
}

/** Interactive bar chart with a real x-axis and a hover tooltip per bar. */
export function LiveBarChart({
  data,
  height = 130,
  tickValues,
  tickRotation = 0,
  padding = 0.25,
  axisFormat,
}: LiveBarChartProps) {
  const resetKey = `${data.length}:${data.reduce((total, datum) => total + datum.value, 0)}`;

  return (
    <ChartHydrationSkeleton height={height} resetKey={resetKey} variant="bar">
      <ResponsiveBar
        data={data as unknown as Record<string, string | number>[]}
        keys={['value']}
        indexBy="id"
        theme={nivoTheme}
        margin={{ top: 8, right: 8, bottom: 28, left: 8 }}
        padding={padding}
        colors={({ data: d }) => (d as unknown as BarDatum).color ?? TR.accent}
        borderRadius={2}
        enableLabel={false}
        enableGridY={false}
        axisLeft={null}
        axisBottom={{
          tickSize: 0,
          tickPadding: 8,
          tickRotation,
          tickValues: tickValues as string[] | undefined,
          format: axisFormat ? (v) => axisFormat(String(v)) : undefined,
        }}
        tooltip={({ data: d }) => {
          const datum = d as unknown as BarDatum;
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
              <div style={{ color: TR.textDim, fontSize: 10.5, marginBottom: 4 }}>{datum.label}</div>
              <div style={{ color: TR.accent, fontWeight: 600 }}>{datum.note}</div>
            </div>
          );
        }}
      />
    </ChartHydrationSkeleton>
  );
}
