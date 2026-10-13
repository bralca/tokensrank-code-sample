'use client';

import { ResponsiveCalendar } from '@nivo/calendar';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { nivoTheme } from '@/lib/nivo-theme';
import { LIME_RAMP } from '@/lib/nivo-theme';
import { ChartHydrationSkeleton } from './ChartHydrationSkeleton';
import { arrayToCalendar, calendarRange } from './utils';

interface LiveCalendarProps {
  /** Oldest→newest daily values (last element = today). */
  values: number[];
  /** Noun for the tooltip, e.g. "tokens" or "lines". */
  unit: string;
  /** Format a value for the tooltip. */
  format: (value: number) => string;
  height?: number;
}

/** GitHub-style calendar heatmap with month labels and a hover tooltip. */
export function LiveCalendar({ values, unit, format, height = 180 }: LiveCalendarProps) {
  const data = arrayToCalendar(values).filter((d) => d.value > 0);
  const { from, to } = calendarRange(values.length);
  // Nivo stacks one calendar row per year, so grow the height when the range
  // spans multiple years (full activity history can cross year boundaries).
  const years = new Date(to).getUTCFullYear() - new Date(from).getUTCFullYear() + 1;
  const resolvedHeight = Math.max(height, years * 165);
  const resetKey = `${values.length}:${data.length}:${data.reduce((total, day) => total + day.value, 0)}`;

  return (
    <ChartHydrationSkeleton height={resolvedHeight} resetKey={resetKey} variant="calendar">
      <ResponsiveCalendar
        data={data}
        from={from}
        to={to}
        theme={nivoTheme}
        emptyColor={TR.bgRow}
        colors={LIME_RAMP.slice(1)}
        minValue={0}
        margin={{ top: 16, right: 12, bottom: 8, left: 24 }}
        monthBorderColor={TR.bg}
        monthLegendOffset={8}
        monthLegend={(_y, _m, date) => date.toLocaleDateString('en-US', { month: 'short' })}
        daySpacing={3}
        dayBorderWidth={2}
        dayBorderColor={TR.bg}
        tooltip={(datum) => {
          const d = datum as unknown as { day: string; value: number };
          const label = new Date(d.day).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
          });
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
              <div style={{ color: TR.textDim, fontSize: 10.5, marginBottom: 4 }}>{label}</div>
              <div style={{ color: TR.accent, fontWeight: 600 }}>
                {format(Number(d.value || 0))} {unit}
              </div>
            </div>
          );
        }}
      />
    </ChartHydrationSkeleton>
  );
}
