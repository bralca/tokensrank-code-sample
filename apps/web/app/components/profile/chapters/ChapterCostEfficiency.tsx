'use client';

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { modelProvider } from '@/lib/nivo-theme';
import { Card, RuleSectionHeader } from '../shared/StatFooter';
import { ChartTimeframeSelector } from '../shared/ChartTimeframeSelector';
import { ChartHydrationSkeleton } from '../charts/ChartHydrationSkeleton';
import { formatLoc, formatUsd } from '../charts/utils';
import { timeframeDays, timeframeDisplayLabel, type ChartTimeframe } from '../charts/timeframes';
import type { ModelUsageHistoryItem } from '../charts/ModelHistoryLineCharts';

interface SpendEfficiencyPoint {
  date: string;
  cost_usd: number;
  shipped_ai_coded_loc: number;
  value: number | null;
  status: 'ok' | 'no_shipped_code' | 'no_activity' | 'zero_cost';
}

interface ChapterCostEfficiencyProps {
  modelUsageHistory: ModelUsageHistoryItem[];
  spendPerShippedAiLoc30d: SpendEfficiencyPoint[];
}

type Series = {
  color: string;
  key: string;
  label: string;
};

type WeeklyRow = {
  id: string;
  week: string;
  weekLabel: string;
  totalSpend: number;
  efficiencyPerK: number | null;
  efficiencyCost: number;
  shippedAiCodedLoc: number;
  [key: string]: string | number | null;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_MODEL_SERIES = 6;
const OTHER_COLOR = '#3A4654';
const CHART_HEIGHT = 300;
const COST_SERIES_PALETTE = {
  claude: ['#8FA0B3', '#6F7F94', '#566575'],
  codex: ['#7BA769', '#A6E85E', '#5F7F48', '#B6FF3C', '#496B39'],
  opencode: ['#21B9A9', '#187C75'],
  other: ['#46515F', '#343D49'],
} as const;
const LINE_COLOR = '#F2F5F7';

function dateToUtcMs(date: string): number {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function weekStart(date: string): string {
  const timestamp = dateToUtcMs(date);
  const day = new Date(timestamp).getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;

  return isoDate(timestamp + diff * MS_PER_DAY);
}

function formatWeekLabel(week: string): string {
  const date = new Date(`${week}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    return week;
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function cutoffForTimeframe(latest: number, timeframe: ChartTimeframe): number {
  const days = timeframeDays(timeframe);

  if (days === null) {
    return Number.NEGATIVE_INFINITY;
  }

  return latest - ((days - 1) * MS_PER_DAY);
}

function weeklyRange(firstWeek: string, lastWeek: string): string[] {
  const weeks: string[] = [];
  const first = dateToUtcMs(firstWeek);
  const last = dateToUtcMs(lastWeek);

  for (let timestamp = first; timestamp <= last; timestamp += 7 * MS_PER_DAY) {
    weeks.push(isoDate(timestamp));
  }

  return weeks;
}

function formatUsdPerKLoc(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';

  return formatUsd(value);
}

function costSeriesColor(model: string, index: number): string {
  const provider = modelProvider(model);
  const palette = COST_SERIES_PALETTE[provider] ?? COST_SERIES_PALETTE.other;

  return palette[index % palette.length] ?? OTHER_COLOR;
}

function Chip({
  accent,
  children,
}: {
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        alignItems: 'center',
        border: `1px solid ${accent ? TR.accent : TR.borderHi}`,
        borderRadius: 999,
        color: accent ? TR.accent : TR.textMid,
        display: 'inline-flex',
        fontFamily: FONT_MONO,
        fontSize: 11,
        gap: 6,
        minHeight: 34,
        padding: '0 14px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>
  );
}

function buildWeeklySpendData(
  history: ModelUsageHistoryItem[],
  efficiency: SpendEfficiencyPoint[],
  timeframe: ChartTimeframe,
): { data: WeeklyRow[]; series: Series[] } {
  const dailyCosts: Array<{ date: string; model: string; cost: number }> = [];

  for (const item of history) {
    let previousCost = 0;

    for (const point of item.points) {
      if (point.cost === undefined) {
        continue;
      }

      const cost = Math.max(0, point.cost - previousCost);
      previousCost = point.cost;

      if (cost > 0) {
        dailyCosts.push({ cost, date: point.date, model: item.model });
      }
    }
  }

  const latest = Math.max(
    0,
    ...dailyCosts.map((point) => dateToUtcMs(point.date)),
    ...efficiency.map((point) => dateToUtcMs(point.date)),
  );

  if (latest <= 0) {
    return { data: [], series: [] };
  }

  const cutoff = cutoffForTimeframe(latest, timeframe);
  const visibleCosts = dailyCosts.filter((point) => dateToUtcMs(point.date) >= cutoff);
  const visibleEfficiency = efficiency.filter((point) => dateToUtcMs(point.date) >= cutoff);

  const modelSpend = new Map<string, number>();
  for (const point of visibleCosts) {
    modelSpend.set(point.model, (modelSpend.get(point.model) ?? 0) + point.cost);
  }

  const topModels = [...modelSpend.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_MODEL_SERIES)
    .map(([model]) => model);
  const topModelSet = new Set(topModels);
  const hasOther = visibleCosts.some((point) => !topModelSet.has(point.model));
  const providerColorIndex = new Map<ReturnType<typeof modelProvider>, number>();
  const series: Series[] = topModels.map((model, index) => {
    const provider = modelProvider(model);
    const providerIndex = providerColorIndex.get(provider) ?? 0;

    providerColorIndex.set(provider, providerIndex + 1);

    return {
      color: costSeriesColor(model, providerIndex),
      key: `model_${index}`,
      label: model,
    };
  });

  if (hasOther) {
    series.push({ color: OTHER_COLOR, key: 'model_other', label: 'Other models' });
  }

  const firstDate = Math.min(
    latest,
    ...visibleCosts.map((point) => dateToUtcMs(point.date)),
    ...visibleEfficiency.map((point) => dateToUtcMs(point.date)),
  );
  const firstWeek = weekStart(isoDate(firstDate));
  const lastWeek = weekStart(isoDate(latest));
  const rows = new Map<string, WeeklyRow>();

  for (const week of weeklyRange(firstWeek, lastWeek)) {
    const row: WeeklyRow = {
      efficiencyCost: 0,
      efficiencyPerK: null,
      id: week,
      shippedAiCodedLoc: 0,
      totalSpend: 0,
      week,
      weekLabel: formatWeekLabel(week),
    };

    for (const item of series) {
      row[item.key] = 0;
    }

    rows.set(week, row);
  }

  for (const point of visibleCosts) {
    const week = weekStart(point.date);
    const row = rows.get(week);

    if (!row) continue;

    const modelIndex = topModels.indexOf(point.model);
    const key = modelIndex >= 0 ? `model_${modelIndex}` : 'model_other';

    row[key] = Number(row[key] ?? 0) + point.cost;
    row.totalSpend += point.cost;
  }

  for (const point of visibleEfficiency) {
    const week = weekStart(point.date);
    const row = rows.get(week);

    if (!row) continue;

    // Keep the most recent rolling value in each week. The API series is daily
    // 30-day efficiency, while this chart deliberately buckets spend weekly.
    row.efficiencyCost = point.cost_usd;
    row.shippedAiCodedLoc = point.shipped_ai_coded_loc;
    row.efficiencyPerK = point.value === null ? null : point.value * 1000;
  }

  return { data: [...rows.values()], series };
}

function EfficiencyTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload as WeeklyRow | undefined;
  if (!row) return null;

  const spendRows = payload
    .filter((item) => typeof item.value === 'number' && Number(item.value) > 0 && String(item.dataKey).startsWith('model_'))
    .map((item) => ({
      color: String(item.color ?? TR.textMid),
      label: String(item.name ?? item.dataKey),
      value: Number(item.value),
    }))
    .sort((left, right) => right.value - left.value);

  return (
    <div
      style={{
        background: TR.bgSoft,
        border: `1px solid ${TR.borderHi}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        color: TR.text,
        fontFamily: FONT_MONO,
        fontSize: 12,
        minWidth: 260,
        padding: '9px 12px',
      }}
    >
      <div style={{ color: TR.textDim, fontSize: 10.5, marginBottom: 8 }}>Week of {row.weekLabel}</div>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: TR.textMid }}>30d $ / 1K shipped LOC</span>
          <span style={{ color: TR.text, fontWeight: 600 }}>{formatUsdPerKLoc(row.efficiencyPerK)}</span>
        </div>
        <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: TR.textMid }}>weekly spend</span>
          <span style={{ color: TR.text, fontWeight: 600 }}>{formatUsd(row.totalSpend)}</span>
        </div>
        {spendRows.map((item) => (
          <div key={item.label} style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ alignItems: 'center', color: TR.textMid, display: 'flex', gap: 7, minWidth: 0 }}>
              <span style={{ background: item.color, borderRadius: 2, height: 8, width: 10 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
            </span>
            <span style={{ color: TR.text, fontWeight: 600 }}>{formatUsd(item.value)}</span>
          </div>
        ))}
        {row.shippedAiCodedLoc > 0 ? (
          <div style={{ color: TR.textDim, marginTop: 4 }}>
            {formatLoc(row.shippedAiCodedLoc)} shipped AI-coded LOC in the rolling window
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderEfficiencyTooltip(props: TooltipContentProps) {
  return <EfficiencyTooltip {...props} />;
}

export function ChapterCostEfficiency({
  modelUsageHistory,
  spendPerShippedAiLoc30d,
}: ChapterCostEfficiencyProps) {
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('30d');
  const chart = useMemo(
    () => buildWeeklySpendData(modelUsageHistory, spendPerShippedAiLoc30d, timeframe),
    [modelUsageHistory, spendPerShippedAiLoc30d, timeframe],
  );
  const okPoints = chart.data.filter((row) => row.efficiencyPerK !== null);
  const latest = [...okPoints].reverse()[0];
  const average = okPoints.length > 0
    ? okPoints.reduce((sum, row) => sum + Number(row.efficiencyPerK), 0) / okPoints.length
    : null;
  const best = okPoints.length > 0
    ? Math.min(...okPoints.map((row) => Number(row.efficiencyPerK)))
    : null;
  const totalSpend = chart.data.reduce((sum, row) => sum + row.totalSpend, 0);
  const firstOk = okPoints[0];
  const trendPct = latest?.efficiencyPerK && firstOk?.efficiencyPerK
    ? ((Number(latest.efficiencyPerK) - Number(firstOk.efficiencyPerK)) / Number(firstOk.efficiencyPerK)) * 100
    : null;
  const latestSpendRow = [...chart.data].reverse().find((row) => row.totalSpend > 0);
  const topSpendModel = latestSpendRow
    ? chart.series
      .map((item) => ({ label: item.label, value: Number(latestSpendRow[item.key] ?? 0) }))
      .sort((left, right) => right.value - left.value)[0]
    : undefined;
  const hasSpend = chart.data.some((row) => row.totalSpend > 0);
  const hasEfficiency = okPoints.length > 0;
  const maxWeeklySpend = Math.max(0, ...chart.data.map((row) => row.totalSpend));
  const maxEfficiency = Math.max(0, ...okPoints.map((row) => Number(row.efficiencyPerK)));
  const spendAxisMax = maxWeeklySpend > 0 ? Math.ceil((maxWeeklySpend * 1.12) / 250) * 250 : 100;
  const efficiencyAxisMax = maxEfficiency > 0 ? Math.ceil((maxEfficiency * 1.12) / 25) * 25 : 100;
  const ticks = chart.data
    .filter((_, index) => index % Math.max(1, Math.round(chart.data.length / 6)) === 0 || index === chart.data.length - 1)
    .map((row) => row.id);
  const resetKey = `${chart.data.length}:${totalSpend}:${latest?.efficiencyPerK ?? 0}`;

  return (
    <section>
      <RuleSectionHeader
        number="02"
        title="Cost efficiency"
        meta={`$ per 1K shipped LOC · rolling efficiency · weekly $ spend by model · ${timeframeDisplayLabel(timeframe)}`}
      />
      <Card>
        <div style={{ padding: '28px 28px 24px' }}>
          <div style={{ alignItems: 'flex-start', display: 'flex', gap: 20, justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '10px 18px', minWidth: 0 }}>
              <div style={{ color: TR.text, fontFamily: FONT_MONO, fontSize: 56, fontWeight: 700, letterSpacing: '-0.06em', lineHeight: 0.95 }}>
                {formatUsdPerKLoc(latest?.efficiencyPerK)}
              </div>
              <div style={{ color: TR.textMid, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1.45 }}>
                per 1K<br />shipped LOC
              </div>
              {trendPct !== null ? (
                <div
                  style={{
                    color: trendPct > 0 ? TR.down : TR.accent,
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    marginLeft: 8,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {trendPct > 0 ? '↑' : '↓'} {Math.round(Math.abs(trendPct))}% this window
                </div>
              ) : null}
            </div>
            <div style={{ alignItems: 'center', display: 'flex', flexShrink: 0, gap: 18 }}>
              <div style={{ alignItems: 'center', color: TR.textMid, display: 'flex', fontFamily: FONT_MONO, fontSize: 11, gap: 7 }}>
                <span style={{ background: LINE_COLOR, borderRadius: 999, height: 3, width: 16 }} />
                $/1K shipped LOC
              </div>
              <div style={{ alignItems: 'center', color: TR.textMid, display: 'flex', fontFamily: FONT_MONO, fontSize: 11, gap: 7 }}>
                <span style={{ background: '#5F7F48', borderRadius: 2, height: 10, width: 12 }} />
                weekly $ spend
              </div>
              <ChartTimeframeSelector value={timeframe} onChange={setTimeframe} />
            </div>
          </div>
          {!hasSpend ? (
            <div style={{ border: `1px solid ${TR.border}`, borderRadius: 10, color: TR.textMid, fontFamily: FONT_MONO, fontSize: 12, padding: 22 }}>
              No model spend data is available in this window yet.
            </div>
          ) : (
            <>
              <ChartHydrationSkeleton height={CHART_HEIGHT} resetKey={resetKey} variant="composed">
                <ResponsiveContainer
                  height="100%"
                  initialDimension={{ height: CHART_HEIGHT, width: 900 }}
                  minHeight={CHART_HEIGHT}
                  minWidth={0}
                  width="100%"
                >
                  <ComposedChart
                    barCategoryGap="28%"
                    barGap={0}
                    data={chart.data}
                    margin={{ top: 12, right: 18, bottom: 22, left: 4 }}
                  >
                    <CartesianGrid stroke={TR.border} strokeDasharray="2 4" strokeOpacity={0.32} vertical={false} />
                    <XAxis
                      axisLine={{ stroke: TR.border }}
                      dataKey="id"
                      interval={0}
                      tick={{ fill: TR.textDim, fontFamily: FONT_MONO, fontSize: 10 }}
                      tickFormatter={(value) => chart.data.find((row) => row.id === value)?.weekLabel ?? ''}
                      tickLine={false}
                      ticks={ticks}
                    />
                    <YAxis
                      axisLine={false}
                      domain={[0, spendAxisMax]}
                      tick={{ fill: TR.textDim, fontFamily: FONT_MONO, fontSize: 10 }}
                      tickFormatter={(value) => formatUsd(Number(value))}
                      tickLine={false}
                      width={56}
                      yAxisId="spend"
                    />
                    <YAxis
                      axisLine={false}
                      domain={[0, efficiencyAxisMax]}
                      orientation="right"
                      tick={{ fill: TR.textDim, fontFamily: FONT_MONO, fontSize: 10 }}
                      tickFormatter={(value) => formatUsd(Number(value))}
                      tickLine={false}
                      width={58}
                      yAxisId="efficiency"
                    />
                    <Tooltip content={renderEfficiencyTooltip} cursor={{ fill: 'rgba(182, 255, 60, 0.035)', stroke: TR.borderHi, strokeWidth: 1 }} />
                    {chart.series.map((item) => (
                      <Bar
                        animationBegin={80}
                        animationDuration={560}
                        animationEasing="ease-out"
                        barSize={42}
                        dataKey={item.key}
                        fill={item.color}
                        fillOpacity={0.78}
                        isAnimationActive
                        key={item.key}
                        maxBarSize={54}
                        minPointSize={2}
                        name={item.label}
                        radius={[2, 2, 0, 0]}
                        stackId="weekly_spend"
                        stroke={TR.bgSoft}
                        strokeOpacity={0.55}
                        strokeWidth={1}
                        yAxisId="spend"
                      />
                    ))}
                    <Line
                      activeDot={{ fill: LINE_COLOR, r: 4, stroke: TR.bgSoft, strokeWidth: 2.5 }}
                      animationBegin={260}
                      animationDuration={760}
                      animationEasing="ease-out"
                      connectNulls={false}
                      dataKey="efficiencyPerK"
                      dot={false}
                      name="$ / 1K shipped LOC"
                      stroke={LINE_COLOR}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeOpacity={0.92}
                      strokeWidth={2.8}
                      type="monotone"
                      yAxisId="efficiency"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartHydrationSkeleton>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '9px 16px', marginTop: 14 }}>
                {chart.series.map((item) => (
                  <div key={item.key} style={{ alignItems: 'center', display: 'flex', gap: 7, minWidth: 0 }}>
                    <span style={{ background: item.color, borderRadius: 2, height: 9, width: 12 }} />
                    <span style={{ color: TR.textMid, fontFamily: FONT_MONO, fontSize: 11, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 20 }}>
                <Chip accent>{formatUsdPerKLoc(latest?.efficiencyPerK)} now</Chip>
                <Chip>{formatUsdPerKLoc(average)} avg</Chip>
                <Chip>{formatUsdPerKLoc(best)} best week</Chip>
                {topSpendModel && topSpendModel.value > 0 ? (
                  <Chip>top spend: {topSpendModel.label}</Chip>
                ) : null}
              </div>
              <div style={{ color: TR.textDim, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.6, marginTop: 16, maxWidth: 860 }}>
                Bars are weekly dollars spent per model; the line is rolling cost per 1K AI-coded LOC that reached the selected production branch.
              </div>
              {!hasEfficiency ? (
                <div style={{ color: TR.textDim, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.6, marginTop: 10 }}>
                  No shipped AI-coded LOC in this window, so the efficiency line is unavailable.
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>
    </section>
  );
}
