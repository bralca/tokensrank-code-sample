'use client';

import { useMemo, useState } from 'react';
import { SectionHeader } from '../shared/SectionHeader';
import { Card, Divider, StatFooter, ChartHeader } from '../shared/StatFooter';
import { ChartTimeframeSelector } from '../shared/ChartTimeframeSelector';
import {
  buildTokenToProdData,
  TokenToProdComposedChart,
  tokenToProdStats,
} from '../charts/TokenToProdComposedChart';
import { formatLoc, formatTokens } from '../charts/utils';
import {
  sliceSeriesByTimeframe,
  timeframeDisplayLabel,
  type ChartTimeframe,
} from '../charts/timeframes';

interface ChapterJourneyProps {
  scorePerDay90d?: number[];
  dailyTokens90d: number[];
  shippedLocPerDay90d: number[];
}

export function ChapterJourney({ dailyTokens90d, shippedLocPerDay90d }: ChapterJourneyProps) {
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('30d');
  const view = useMemo(() => {
    const data = buildTokenToProdData(
      sliceSeriesByTimeframe(dailyTokens90d ?? [], timeframe),
      sliceSeriesByTimeframe(shippedLocPerDay90d ?? [], timeframe),
    );
    const hasData = data.some((point) => point.tokens > 0 || point.loc > 0);

    if (!hasData) {
      return null;
    }

    return { data, stats: tokenToProdStats(data) };
  }, [dailyTokens90d, shippedLocPerDay90d, timeframe]);

  if (!view) return null;

  const { data, stats } = view;

  return (
    <section>
      <SectionHeader
        eyebrow="TOKEN TO PROD"
        title="Token usage and shipped code"
        subtitle="Daily tokens as context, with 7-day token and shipped AI-coded LOC trends on the same timeline."
        meta={timeframeDisplayLabel(timeframe)}
      />
      <Card>
        <div style={{ padding: '20px 24px 10px' }}>
          <ChartHeader label="Token usage vs shipped production LOC">
            <ChartTimeframeSelector value={timeframe} onChange={setTimeframe} />
          </ChartHeader>
          <TokenToProdComposedChart
            data={data}
            height={300}
          />
        </div>
        <Divider />
        <StatFooter
	          stats={[
	            { label: 'Tokens', value: formatTokens(stats.tokens), sub: `${stats.tokenDays} active days` },
	            { label: 'Shipped AI-coded', value: formatLoc(stats.loc), sub: `${stats.shipDays} ship days`, accent: stats.loc > 0 },
	            { label: 'Overlap', value: stats.overlapDays.toLocaleString('en-US'), sub: 'days with both' },
	            { label: 'Ship days', value: stats.shipDays.toLocaleString('en-US'), sub: 'days with shipped LOC', accent: stats.loc > 0 },
	          ]}
	        />
      </Card>
    </section>
  );
}
