'use client';

import { useMemo, useState } from 'react';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { Card, Divider, StatFooter, ChartHeader, RuleSectionHeader } from '../shared/StatFooter';
import { ChartTimeframeSelector } from '../shared/ChartTimeframeSelector';
import { formatLoc, formatTokens, formatUsd } from '../charts/utils';
import {
  sliceSeriesByTimeframe,
  timeframeDisplayLabel,
  type ChartTimeframe,
} from '../charts/timeframes';

interface ChapterCodeFunnelProps {
  dailyTokens90d: number[];
  producedLocPerDay90d: number[];
  shippedProducedLocPerDay90d: number[];
  githubShippedLocPerDay90d: number[];
  spendPerShippedAiLoc30d?: SpendEfficiencyPoint[];
}

interface SpendEfficiencyPoint {
  date: string;
  cost_usd: number;
  shipped_ai_coded_loc: number;
  value: number | null;
  status: 'ok' | 'no_shipped_code' | 'no_activity' | 'zero_cost';
}

const FUNNEL_COLORS = {
  tokens: '#5F8064',
  tokensBg: 'rgba(95, 128, 100, 0.16)',
  ai: '#7BC466',
  aiBg: 'rgba(123, 196, 102, 0.17)',
  shipped: '#A6F45C',
  shippedBg: 'rgba(166, 244, 92, 0.18)',
  transitionOne: 'linear-gradient(90deg, rgba(95,128,100,0.22), rgba(123,196,102,0.18))',
  transitionTwo: 'linear-gradient(90deg, rgba(123,196,102,0.2), rgba(166,244,92,0.18))',
};

function sum(values: number[]): number {
  return values.reduce((total, value) => total + Math.max(0, value || 0), 0);
}

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0%';
  const value = (numerator / denominator) * 100;
  if (value >= 10) return `${Math.round(value)}%`;
  return `${value.toFixed(1).replace(/\.0$/u, '')}%`;
}

function FunnelStep({
  color,
  label,
  sub,
  value,
  bg,
}: {
  bg: string;
  color: string;
  label: string;
  sub: string;
  value: string;
}) {
  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${color}38`,
        borderRadius: 8,
        minWidth: 0,
        padding: '18px 18px 16px',
      }}
    >
      <div style={{ color, fontFamily: FONT_MONO, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ color: TR.text, fontFamily: FONT_MONO, fontSize: 30, fontWeight: 600, letterSpacing: '-0.04em', marginTop: 13, overflowWrap: 'anywhere' }}>
        {value}
      </div>
      <div style={{ color: TR.textDim, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.5, marginTop: 6 }}>
        {sub}
      </div>
    </div>
  );
}

function TransitionBar({
  label,
  valueLabel,
  widthPct,
  background,
}: {
  background: string;
  label: string;
  valueLabel?: string;
  widthPct: number;
}) {
  const width = Math.max(0, Math.min(100, widthPct));

  return (
    <div style={{ display: 'grid', gap: 7 }}>
      <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ color: TR.textDim, fontFamily: FONT_MONO, fontSize: 10.5 }}>{label}</span>
        {valueLabel ? (
          <span style={{ color: TR.textMid, fontFamily: FONT_MONO, fontSize: 10.5 }}>{valueLabel}</span>
        ) : null}
      </div>
      <div style={{ background: TR.bgRow, border: `1px solid ${TR.border}`, borderRadius: 999, height: 11, overflow: 'hidden' }}>
        <div
          style={{
            background,
            height: '100%',
            minWidth: width > 0 ? 3 : 0,
            width: `${width}%`,
          }}
        />
      </div>
    </div>
  );
}

function formatUsdPerKLoc(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return formatUsd(value * 1000);
}

export function ChapterCodeFunnel({
  dailyTokens90d,
  githubShippedLocPerDay90d,
  producedLocPerDay90d,
  spendPerShippedAiLoc30d = [],
  shippedProducedLocPerDay90d,
}: ChapterCodeFunnelProps) {
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('30d');
  const stats = useMemo(() => {
    const visibleTokens = sliceSeriesByTimeframe(dailyTokens90d, timeframe);
    const visibleProduced = sliceSeriesByTimeframe(producedLocPerDay90d, timeframe);
    const visibleShipped = sliceSeriesByTimeframe(shippedProducedLocPerDay90d, timeframe);
    const visibleGithubShipped = sliceSeriesByTimeframe(githubShippedLocPerDay90d, timeframe);
    const tokens = sum(visibleTokens);
    const producedLoc = sum(visibleProduced);
    const shippedLoc = sum(visibleShipped);
    const githubShippedLoc = sum(visibleGithubShipped);
    const visibleEfficiency = spendPerShippedAiLoc30d.length > 0
      ? sliceSeriesByTimeframe(spendPerShippedAiLoc30d, timeframe)
      : [];
    const latestEfficiency = [...visibleEfficiency].reverse().find((point) => point.value !== null);

    return {
      githubShippedLoc,
      latestEfficiency,
      producedLoc,
      shippedLoc,
      tokens,
      unshippedLoc: Math.max(0, producedLoc - shippedLoc),
      visibleEfficiency,
    };
  }, [dailyTokens90d, githubShippedLocPerDay90d, producedLocPerDay90d, spendPerShippedAiLoc30d, shippedProducedLocPerDay90d, timeframe]);

  const hasAnyData = stats.tokens > 0 || stats.producedLoc > 0 || stats.githubShippedLoc > 0;
  if (!hasAnyData) return null;
  const shippedWidth = stats.producedLoc > 0 ? (stats.shippedLoc / stats.producedLoc) * 100 : 0;

  return (
    <section>
      <RuleSectionHeader
        number="01"
        title="AI code conversion"
        meta={`tokens → direct SHA LOC → selected prod branch · ${timeframeDisplayLabel(timeframe)}`}
      />
      <Card>
        <div style={{ padding: '24px 26px 20px' }}>
          <ChartHeader label="Direct SHA attribution">
            <ChartTimeframeSelector value={timeframe} onChange={setTimeframe} />
          </ChartHeader>
          <div
            style={{
              display: 'grid',
              gap: 16,
            }}
          >
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
              <FunnelStep
                bg={FUNNEL_COLORS.tokensBg}
                color={FUNNEL_COLORS.tokens}
                label="Tokens used"
                sub="local Claude, Codex, and OpenCode usage"
                value={formatTokens(stats.tokens)}
              />
              <FunnelStep
                bg={FUNNEL_COLORS.aiBg}
                color={FUNNEL_COLORS.ai}
                label="AI-coded LOC"
                sub="direct commit SHA evidence"
                value={`${formatLoc(stats.producedLoc)} LOC`}
              />
              <FunnelStep
                bg={FUNNEL_COLORS.shippedBg}
                color={FUNNEL_COLORS.shipped}
                label="Shipped AI-coded LOC"
                sub="in selected prod branch"
                value={`${formatLoc(stats.shippedLoc)} LOC`}
              />
            </div>
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
              <TransitionBar
                background={FUNNEL_COLORS.transitionOne}
                label="token usage context"
                widthPct={stats.tokens > 0 && stats.producedLoc > 0 ? 100 : 0}
              />
              <TransitionBar
                background={FUNNEL_COLORS.transitionTwo}
                label="AI-coded LOC that shipped"
                valueLabel={pct(stats.shippedLoc, stats.producedLoc)}
                widthPct={shippedWidth}
              />
            </div>
          </div>
          <div style={{ color: TR.textDim, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.6, marginTop: 12 }}>
            Direct-linked means the local AI log contained a git commit SHA that resolved in a selected repo. No time-window matching is used.
          </div>
        </div>
        <Divider />
        <StatFooter
          stats={[
            { label: 'AI-coded LOC', value: `${formatLoc(stats.producedLoc)}`, sub: 'direct SHA non-doc LOC' },
            { label: 'Shipped AI-coded', value: `${formatLoc(stats.shippedLoc)}`, sub: 'LOC', accent: stats.shippedLoc > 0 },
            { label: 'Unshipped AI-coded', value: `${formatLoc(stats.unshippedLoc)}`, sub: 'LOC' },
            { label: 'GitHub verified prod', value: `${formatLoc(stats.githubShippedLoc)}`, sub: 'LOC ceiling' },
            {
              label: '$ / 1K shipped LOC',
              value: formatUsdPerKLoc(stats.latestEfficiency?.value),
              sub: stats.latestEfficiency ? 'per 1K LOC' : 'needs shipped AI-coded LOC',
              accent: Boolean(stats.latestEfficiency?.value),
            },
          ]}
        />
      </Card>
    </section>
  );
}
