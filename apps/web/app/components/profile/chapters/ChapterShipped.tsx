'use client';

import { useMemo, useState } from 'react';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { SectionHeader } from '../shared/SectionHeader';
import { Card, Divider, StatFooter, ChartHeader, ChartLabel } from '../shared/StatFooter';
import { ChartTimeframeSelector } from '../shared/ChartTimeframeSelector';
import { LiveCalendar } from '../charts/LiveCalendar';
import { formatLoc } from '../charts/utils';
import {
  sliceSeriesByTimeframe,
  timeframeDisplayLabel,
  type ChartTimeframe,
} from '../charts/timeframes';

interface ChapterShippedProps {
  shippedLocPerDay90d: number[];
  shippedLocTotal: number;
}

const SHIPPING_TIERS = [
  { name: 'Seedling', min: 0, desc: 'first lines' },
  { name: 'Builder', min: 1_000, desc: '1k+ lines' },
  { name: 'Shipper', min: 10_000, desc: '10k+ lines' },
  { name: 'Maintainer', min: 50_000, desc: '50k+ lines' },
  { name: 'Architect', min: 200_000, desc: '200k+ lines' },
];

function currentTierIndex(loc: number): number {
  let idx = 0;
  for (let i = 0; i < SHIPPING_TIERS.length; i += 1) {
    if (loc >= (SHIPPING_TIERS[i]?.min ?? 0)) idx = i;
  }
  return idx;
}

export function ChapterShipped({
  shippedLocPerDay90d,
  shippedLocTotal,
}: ChapterShippedProps) {
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('30d');
  const visibleLoc = useMemo(
    () => sliceSeriesByTimeframe(shippedLocPerDay90d, timeframe),
    [shippedLocPerDay90d, timeframe],
  );
  const hasData = shippedLocTotal > 0 || shippedLocPerDay90d.some((value) => value > 0);

  if (!hasData) {
    return (
      <section>
        <SectionHeader
          eyebrow="06 SHIPPED TO PROD"
          title="Shipped code breakdown"
          subtitle="Non-doc lines merged to your prod branch."
        />
        <div
          style={{
            backgroundColor: TR.bgSoft,
            border: `1px solid ${TR.border}`,
            borderRadius: 12,
            padding: 24,
            color: TR.textMid,
            fontFamily: FONT_MONO,
            fontSize: 13,
          }}
        >
          No shipped code yet — connect a repo so merged, non-doc lines count toward your rank.
        </div>
      </section>
    );
  }

  const tierIdx = currentTierIndex(shippedLocTotal);
  const currentTier = SHIPPING_TIERS[tierIdx] ?? SHIPPING_TIERS[0];
  const visibleLocTotal = timeframe === 'all' ? shippedLocTotal : visibleLoc.reduce((sum, value) => sum + value, 0);
  const activeDays = visibleLoc.filter((value) => value > 0).length;
  const bestDay = visibleLoc.length > 0 ? Math.max(0, ...visibleLoc) : 0;

  return (
    <section>
      <SectionHeader
        eyebrow="06 SHIPPED TO PROD"
        title="Shipped code breakdown"
        subtitle="Non-doc lines merged to your prod branch, per day. Hover any square for that day's count."
        meta={timeframeDisplayLabel(timeframe)}
      />
      <Card>
        <div style={{ padding: '20px 24px 8px' }}>
          <ChartHeader label="Lines merged per day">
            <ChartTimeframeSelector value={timeframe} onChange={setTimeframe} />
          </ChartHeader>
          <LiveCalendar values={visibleLoc} unit="lines" format={formatLoc} height={180} />
        </div>

        <Divider />
        <div style={{ padding: '20px 24px' }}>
          <ChartLabel>Shipping tier</ChartLabel>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {SHIPPING_TIERS.map((tier, i) => {
              const isUnlocked = shippedLocTotal >= tier.min;
              const isCurrent = i === tierIdx;
              return (
                <div
                  key={tier.name}
                  style={{
                    padding: '12px 16px',
                    backgroundColor: isCurrent ? TR.accent : isUnlocked ? TR.borderHi : TR.bgRow,
                    color: isCurrent ? TR.bg : TR.text,
                    borderRadius: 8,
                    textAlign: 'center',
                    minWidth: 92,
                    opacity: isUnlocked ? 1 : 0.45,
                  }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4, fontFamily: FONT_MONO }}>{tier.name}</div>
                  <div style={{ fontSize: 10.5, opacity: 0.85, fontFamily: FONT_MONO }}>{tier.desc}</div>
                </div>
              );
            })}
          </div>
        </div>

        <Divider />
        <StatFooter
          stats={[
            { label: 'Total shipped', value: `${visibleLocTotal.toLocaleString()}`, sub: 'non-doc LOC' },
            { label: 'Active days', value: String(activeDays), sub: `tier: ${currentTier.name}`, accent: true },
            { label: 'Best day', value: `${bestDay.toLocaleString()}`, sub: 'LOC' },
            { label: 'Source', value: 'GitHub', sub: 'verified prod branch' },
          ]}
        />
      </Card>
    </section>
  );
}
