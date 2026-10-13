'use client';

import { useMemo, useState } from 'react';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { EmptyState } from './shared/EmptyState';
import { SectionHeader } from '../shared/SectionHeader';
import { Card, Divider, StatFooter, ChartHeader } from '../shared/StatFooter';
import { ChartTimeframeSelector } from '../shared/ChartTimeframeSelector';
import { LiveAreaChart } from '../charts/LiveAreaChart';
import {
  sliceSeriesByTimeframe,
  timeframeDisplayLabel,
  type ChartTimeframe,
} from '../charts/timeframes';

interface ChapterL1VolumeProps {
  dailyTokens90d: number[];
  totalSessions: number;
  totalTimeInSessions: string;
  medianSession: string;
  longestSession: string;
  longestSessionDate?: string;
  mostExpensive: string;
  mostExpensiveDate?: string;
  cacheAge?: string;
  dataStart?: string;
  dataEnd?: string;
}

export function ChapterL1Volume({
  dailyTokens90d,
  totalSessions,
  totalTimeInSessions,
  medianSession,
  longestSession,
  longestSessionDate,
  mostExpensive,
  mostExpensiveDate,
  cacheAge = '2m ago',
  dataStart,
  dataEnd,
}: ChapterL1VolumeProps) {
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('30d');
  const visibleTokens = useMemo(
    () => sliceSeriesByTimeframe(dailyTokens90d, timeframe),
    [dailyTokens90d, timeframe],
  );
  const hasData = dailyTokens90d.some((value) => value > 0);

  if (!hasData) {
    return (
      <section>
        <SectionHeader
          eyebrow="08 TOKEN USAGE"
          title="Cumulative token usage"
          subtitle="Tokens added over time."
          meta={`Updated ${cacheAge} · all time`}
        />
        <div style={{ backgroundColor: TR.bgSoft, border: `1px solid ${TR.border}`, borderRadius: 12, padding: 24 }}>
          <EmptyState condition="no_sessions" />
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionHeader
        eyebrow="08 TOKEN USAGE"
        title="Cumulative token usage"
        subtitle="Running token total since you connected. Hover for any day's total."
        meta={`Updated ${cacheAge} · ${timeframeDisplayLabel(timeframe)}`}
      />
      <Card>
        <div style={{ padding: '20px 24px 12px' }}>
          <ChartHeader label="Cumulative tokens">
            <ChartTimeframeSelector value={timeframe} onChange={setTimeframe} />
          </ChartHeader>
          <LiveAreaChart daily={visibleTokens} height={240} />
        </div>
        <Divider />
        <StatFooter
          stats={[
            { label: 'Sessions', value: totalSessions.toLocaleString() },
            { label: 'Total time', value: totalTimeInSessions },
            { label: 'Median session', value: medianSession },
            { label: 'Longest', value: longestSession, sub: longestSessionDate, accent: true },
            { label: 'Most expensive', value: mostExpensive, sub: mostExpensiveDate },
          ]}
        />
        {(dataStart || dataEnd) && (
          <>
            <Divider />
            <div
              style={{
                padding: '10px 24px',
                fontSize: 10.5,
                fontFamily: FONT_MONO,
                color: TR.textDim,
                letterSpacing: '0.04em',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
              }}
            >
              <span>data range:</span>
              <span style={{ color: TR.textMid }}>{dataStart ?? '—'}</span>
              <span>→</span>
              <span style={{ color: TR.textMid }}>{dataEnd ?? '—'}</span>
            </div>
          </>
        )}
      </Card>
    </section>
  );
}
