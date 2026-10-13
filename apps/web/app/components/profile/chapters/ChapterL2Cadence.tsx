'use client';

import { useMemo, useState } from 'react';
import { TR } from '@/lib/design-tokens';
import { EmptyState } from './shared/EmptyState';
import { SectionHeader } from '../shared/SectionHeader';
import { Card, Divider, StatFooter, ChartLabel } from '../shared/StatFooter';
import { ChartTimeframeSelector } from '../shared/ChartTimeframeSelector';
import { LiveBarChart, type BarDatum } from '../charts/LiveBarChart';
import {
  sliceSeriesByTimeframe,
  timeframeDisplayLabel,
  type ChartTimeframe,
} from '../charts/timeframes';

type CadenceWindowSummary = {
  busiest_day: string | null;
  busiest_hour: string | null;
  hourly: number[];
  daily: number[];
  after_midnight: { count: number; pct: number };
  weekend_share: number;
  sessions_count: number;
};

interface ChapterL2CadenceProps {
  dailyTokens90d: number[];
  hourlyHistogram: number[];
  dailyHistogram: number[];
  cadenceWindows?: Partial<Record<ChartTimeframe, CadenceWindowSummary>>;
  busiestHour?: string;
  busiestDay?: string;
  weekendShare: number;
  afterMidnight: { count: number; pct: number };
  streakBands: unknown[];
  currentStreak: number;
  longestStreak: number;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function ChapterL2Cadence({
  dailyTokens90d,
  hourlyHistogram,
  dailyHistogram,
  cadenceWindows,
  busiestHour,
  busiestDay,
  weekendShare,
  afterMidnight,
  currentStreak,
  longestStreak,
}: ChapterL2CadenceProps) {
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('30d');
  const fallbackWindow = useMemo<CadenceWindowSummary>(() => ({
    busiest_day: busiestDay ?? null,
    busiest_hour: busiestHour ?? null,
    hourly: hourlyHistogram,
    daily: dailyHistogram,
    after_midnight: afterMidnight,
    weekend_share: weekendShare,
    sessions_count: dailyHistogram.reduce((total, value) => total + value, 0),
  }), [afterMidnight, busiestDay, busiestHour, dailyHistogram, hourlyHistogram, weekendShare]);
  const activeWindow = cadenceWindows?.[timeframe] ?? (timeframe === 'all' ? cadenceWindows?.all : undefined) ?? fallbackWindow;
  const hasAnyData = dailyTokens90d.some((value) => value > 0)
    || Object.values(cadenceWindows ?? {}).some((item) => (item?.sessions_count ?? 0) > 0)
    || fallbackWindow.sessions_count > 0;
  const hasWindowTokens = sliceSeriesByTimeframe(dailyTokens90d, timeframe).some((value) => value > 0);
  const hasWindowSessions = activeWindow.sessions_count > 0;
  const hasSelectedWindowData = hasWindowTokens || hasWindowSessions;

  const hourBars = useMemo<BarDatum[]>(
    () =>
      activeWindow.hourly.map((value, hour) => ({
        id: String(hour),
        value,
        color: TR.accent,
        label: `${String(hour).padStart(2, '0')}:00 UTC`,
        note: `${value} session${value === 1 ? '' : 's'}`,
      })),
    [activeWindow.hourly],
  );

  const dayBars = useMemo<BarDatum[]>(
    () =>
      activeWindow.daily.map((value, i) => ({
        id: DAY_NAMES[i] ?? String(i),
        value,
        color: TR.accent,
        label: DAY_NAMES[i] ?? String(i),
        note: `${value} session${value === 1 ? '' : 's'}`,
      })),
    [activeWindow.daily],
  );

  if (!hasAnyData) {
    return (
      <section>
        <SectionHeader eyebrow="05 WORK RHYTHM" title="Session rhythm" subtitle="The hours and days you tend to work." />
        <div style={{ backgroundColor: TR.bgSoft, border: `1px solid ${TR.border}`, borderRadius: 12, padding: 24 }}>
          <EmptyState condition="no_sessions" />
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionHeader
        eyebrow="05 WORK RHYTHM"
        title="Session rhythm"
        subtitle="Sessions by hour and weekday. Hover any bar for exact counts."
        meta={`UTC · ${timeframeDisplayLabel(timeframe)}`}
      />
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '20px 24px 0' }}>
          <ChartLabel>Session distribution</ChartLabel>
          <ChartTimeframeSelector value={timeframe} onChange={setTimeframe} />
        </div>
        {!hasSelectedWindowData ? (
          <div style={{ padding: '18px 24px 20px' }}>
            <EmptyState condition="no_sessions" />
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              <div style={{ padding: '20px 24px 4px' }}>
                <ChartLabel>Sessions by hour</ChartLabel>
                <LiveBarChart
                  data={hourBars}
                  height={130}
                  tickValues={['0', '3', '6', '9', '12', '15', '18', '21']}
                  padding={0.3}
                />
              </div>
              <div style={{ padding: '20px 24px 4px', borderLeft: `1px solid ${TR.border}` }}>
                <ChartLabel>Sessions by day</ChartLabel>
                <LiveBarChart data={dayBars} height={130} padding={0.4} />
              </div>
            </div>
            <Divider />
            <StatFooter
              stats={[
                { label: 'Busiest hour', value: activeWindow.busiest_hour || '—' },
                { label: 'Busiest day', value: activeWindow.busiest_day || '—' },
                { label: 'Weekend', value: `${Math.round(activeWindow.weekend_share * 100)}%`, sub: 'of activity' },
                { label: 'After midnight', value: `${Math.round(activeWindow.after_midnight.pct * 100)}%`, sub: `${activeWindow.after_midnight.count} sessions` },
                { label: 'Current streak', value: `${currentStreak}d`, accent: currentStreak > 0 },
                { label: 'Longest streak', value: `${longestStreak}d` },
              ]}
            />
          </>
        )}
      </Card>
    </section>
  );
}
