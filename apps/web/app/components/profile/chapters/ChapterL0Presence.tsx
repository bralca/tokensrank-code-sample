'use client';

import { useMemo, useState } from 'react';
import { TR } from '@/lib/design-tokens';
import { EmptyState } from './shared/EmptyState';
import { SectionHeader } from '../shared/SectionHeader';
import { Card, Divider, StatFooter, ChartHeader } from '../shared/StatFooter';
import { ChartTimeframeSelector } from '../shared/ChartTimeframeSelector';
import { LiveCalendar } from '../charts/LiveCalendar';
import { formatTokens } from '../charts/utils';
import {
  sliceSeriesByTimeframe,
  timeframeDisplayLabel,
  type ChartTimeframe,
} from '../charts/timeframes';

interface ChapterL0PresenceProps {
  dailyTokens90d: number[];
  activeDays: number;
  daysSinceJoin?: number;
  lastSessionTime?: string;
  lastSessionTimestamp?: string;
  connectedDate?: string;
  archetype?: string;
  cacheAge?: string;
}

export function ChapterL0Presence({
  dailyTokens90d,
  activeDays,
  daysSinceJoin = 308,
  lastSessionTime = '—',
  lastSessionTimestamp = '—',
  connectedDate = '—',
  archetype = '—',
  cacheAge = '2m ago',
}: ChapterL0PresenceProps) {
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('30d');
  const visibleTokens = useMemo(
    () => sliceSeriesByTimeframe(dailyTokens90d, timeframe),
    [dailyTokens90d, timeframe],
  );
  const hasData = dailyTokens90d.some((value) => value > 0);
  const visibleActiveDays = visibleTokens.filter((value) => value > 0).length;
  const activeDaysDenominator = timeframe === 'all' ? daysSinceJoin : visibleTokens.length;

  if (!hasData) {
    return (
      <section>
        <SectionHeader
          eyebrow="07 CONSISTENCY"
          title="Daily token activity"
          subtitle="Every square is a day. Brighter means more tokens."
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
        eyebrow="07 CONSISTENCY"
        title="Daily token activity"
        subtitle="Every square is a day since you connected. Brighter means more tokens that day. Hover for the exact count."
        meta={`Updated ${cacheAge} · ${timeframeDisplayLabel(timeframe)}`}
      />
      <Card>
        <div style={{ padding: '20px 24px 8px' }}>
          <ChartHeader label="Tokens per day">
            <ChartTimeframeSelector value={timeframe} onChange={setTimeframe} />
          </ChartHeader>
          <LiveCalendar values={visibleTokens} unit="tokens" format={formatTokens} height={180} />
        </div>
        <Divider />
        <StatFooter
          stats={[
            { label: 'Active days', value: String(timeframe === 'all' ? activeDays : visibleActiveDays), sub: `of ${activeDaysDenominator} days` },
            { label: 'Last session', value: lastSessionTime, sub: lastSessionTimestamp },
            { label: 'Connected', value: connectedDate, sub: 'script verified' },
            { label: 'Archetype', value: archetype },
          ]}
        />
      </Card>
    </section>
  );
}
