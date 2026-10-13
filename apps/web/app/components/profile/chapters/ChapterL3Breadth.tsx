'use client';

import { useState } from 'react';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { getDistinctModelColor, providerLogo } from '@/lib/nivo-theme';
import { EmptyState } from './shared/EmptyState';
import { SectionHeader } from '../shared/SectionHeader';
import { Card, Divider, StatFooter, ChartHeader, ChartLabel } from '../shared/StatFooter';
import { ChartTimeframeSelector } from '../shared/ChartTimeframeSelector';
import {
  ModelUsageHistoryChart,
  ProviderSpendHistoryChart,
  type ModelUsageHistoryItem,
  type ProviderSpendHistoryItem,
} from '../charts/ModelHistoryLineCharts';
import { formatLoc, formatTokens, formatUsd } from '../charts/utils';
import { timeframeDays, type ChartTimeframe } from '../charts/timeframes';

interface ModelMetrics90d {
  model: string;
  tokens_total: number;
  tokens_14d_prev: number;
  tokens_14d_curr: number;
  trend: 'up' | 'down' | 'flat';
}

interface ModelItem {
  name: string;
  tokens: number;
  cost: number;
  share: number;
  sessions?: number;
}

interface ChapterL3BreadthProps {
  modelMetrics90d: ModelMetrics90d[];
  modelUsageHistory: ModelUsageHistoryItem[];
  models: ModelItem[];
  providerSpendHistory: ProviderSpendHistoryItem[];
  distinctModels: number;
  topBySession?: string;
  firstModel?: { name: string; date: string };
  latestModel?: { name: string; date: string };
}

function trendPct(prev: number, curr: number): string {
  if (prev <= 0) return curr > 0 ? 'new' : '—';
  const pct = ((curr - prev) / prev) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${Math.round(pct)}%`;
}

function dateToUtcMs(date: string): number {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function buildTimeframedModelRows(
  history: ModelUsageHistoryItem[],
  timeframe: ChartTimeframe,
  fallbackModels: ModelItem[],
): ModelItem[] {
  const latest = Math.max(
    0,
    ...history.flatMap((item) => item.points.map((point) => dateToUtcMs(point.date))),
  );
  const days = timeframeDays(timeframe);
  const cutoff = days === null ? Number.NEGATIVE_INFINITY : latest - ((days - 1) * 24 * 60 * 60 * 1000);
  const fallbackByModel = new Map(fallbackModels.map((model) => [model.name, model]));
  const rows = history.map<ModelItem | null>((item) => {
    let previousTokens = 0;
    let previousCost = 0;
    let latestTokens = 0;
    let latestCost = 0;
    let sawCost = false;

    for (const point of item.points) {
      const timestamp = dateToUtcMs(point.date);
      const pointCost = point.cost ?? previousCost;

      if (point.cost !== undefined) {
        sawCost = true;
      }

      if (timestamp < cutoff) {
        previousTokens = point.tokens;
        previousCost = pointCost;
        continue;
      }

      latestTokens = point.tokens;
      latestCost = pointCost;
    }

    const tokens = Math.max(0, latestTokens - previousTokens);
    const fallback = fallbackByModel.get(item.model);
    const cost = sawCost ? Math.max(0, latestCost - previousCost) : fallback?.cost ?? 0;

    if (tokens <= 0 && cost <= 0) {
      return null;
    }

    return {
      name: item.model,
      tokens,
      cost: Math.round(cost * 100) / 100,
      share: 0,
      sessions: fallback?.sessions,
    };
  }).filter((item): item is ModelItem => item !== null);

  const totalTokens = rows.reduce((sum, model) => sum + model.tokens, 0);

  return rows
    .map((model) => ({
      ...model,
      share: totalTokens > 0 ? model.tokens / totalTokens : 0,
    }))
    .sort((left, right) => right.cost - left.cost || right.tokens - left.tokens);
}

export function ChapterL3Breadth({
  modelMetrics90d,
  modelUsageHistory,
  models,
  providerSpendHistory,
  distinctModels,
  topBySession,
  firstModel,
  latestModel,
}: ChapterL3BreadthProps) {
  const [providerTimeframe, setProviderTimeframe] = useState<ChartTimeframe>('30d');
  const [modelTimeframe, setModelTimeframe] = useState<ChartTimeframe>('30d');
  const hasData = modelMetrics90d.length > 0
    || models.length > 0
    || modelUsageHistory.length > 0
    || providerSpendHistory.length > 0;

  if (!hasData) {
    return (
      <section>
        <SectionHeader eyebrow="04 MODEL MIX" title="Model usage over time" subtitle="The models behind your tokens." />
        <div style={{ backgroundColor: TR.bgSoft, border: `1px solid ${TR.border}`, borderRadius: 12, padding: 24 }}>
          <EmptyState condition="need_2_models" />
        </div>
      </section>
    );
  }

  const metricsByModel = new Map(modelMetrics90d.map((metric) => [metric.model, metric]));
  const fallbackModels = modelMetrics90d.map<ModelItem>((metric) => ({
    name: metric.model,
    tokens: metric.tokens_total,
    cost: 0,
    share: 0,
  }));
  const baseModels = models.length > 0 ? models : fallbackModels;
  const timeframedModels = modelUsageHistory.length > 0
    ? buildTimeframedModelRows(modelUsageHistory, modelTimeframe, baseModels)
    : [];
  const modelRows = (timeframedModels.length > 0 ? timeframedModels : baseModels)
    .filter((model) => model.tokens > 0 || model.cost > 0)
    .sort((left, right) => right.cost - left.cost || right.tokens - left.tokens)
    .slice(0, 7);
  const hasCosts = modelRows.some((model) => model.cost > 0);
  const maxBarValue = Math.max(1, ...modelRows.map((model) => hasCosts ? model.cost : model.tokens));
  const totalCost = models.reduce((sum, model) => sum + model.cost, 0);
  const topCostModel = modelRows.find((model) => model.cost > 0) ?? null;
  const hasProviderSpend = providerSpendHistory.length > 0;
  const hasModelHistory = modelUsageHistory.length > 0;

  return (
    <section>
      <SectionHeader
        eyebrow="04 MODEL MIX"
        title="Model usage over time"
        subtitle="100% stacked 7-day moving averages for provider spend and model token share, plus the current 14-day direction."
      />
      <Card>
        {hasProviderSpend ? (
          <div style={{ padding: '20px 24px 10px' }}>
            <ChartHeader label="7-day spend mix by provider">
              <ChartTimeframeSelector value={providerTimeframe} onChange={setProviderTimeframe} />
            </ChartHeader>
            <ProviderSpendHistoryChart history={providerSpendHistory} height={288} mode="share" timeframe={providerTimeframe} />
          </div>
        ) : null}

        {hasModelHistory ? (
          <>
            {hasProviderSpend ? <Divider /> : null}
            <div style={{ padding: '20px 24px 10px' }}>
              <ChartHeader label="7-day token mix by model">
                <ChartTimeframeSelector value={modelTimeframe} onChange={setModelTimeframe} />
              </ChartHeader>
              <ModelUsageHistoryChart history={modelUsageHistory} height={372} mode="share" timeframe={modelTimeframe} />
            </div>
          </>
        ) : null}

        {(hasProviderSpend || hasModelHistory) ? <Divider /> : null}
        <div style={{ padding: '20px 24px' }}>
          <ChartLabel>Model cost and 14-day movement</ChartLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {modelRows.map((model) => {
              const metric = metricsByModel.get(model.name);
              const trend = metric?.trend ?? 'flat';
              const arrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';
              const color = trend === 'up' ? TR.accent : trend === 'down' ? TR.down : TR.flat;
              const logo = providerLogo(model.name);
              const barValue = hasCosts ? model.cost : model.tokens;
              const costShare = totalCost > 0 ? (model.cost / totalCost) * 100 : 0;

              return (
                <div key={model.name} style={{ alignItems: 'center', display: 'flex', gap: 12, minWidth: 0 }}>
                  {logo ? (
                    <img src={logo} alt="" width={16} height={16} style={{ flexShrink: 0, borderRadius: 3 }} />
                  ) : (
                    <span style={{ width: 16, height: 16, borderRadius: 3, background: getDistinctModelColor(model.name), flexShrink: 0 }} />
                  )}
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 12.5,
                      color: TR.text,
                      width: 200,
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {model.name}
                  </span>
                  <div style={{ flex: 1, height: 8, background: TR.bgRow, borderRadius: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${(barValue / maxBarValue) * 100}%`,
                        height: '100%',
                        background: getDistinctModelColor(model.name),
                        borderRadius: 4,
                      }}
                    />
                  </div>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: TR.textMid, width: 68, textAlign: 'right', flexShrink: 0 }}>
                    {formatTokens(model.tokens)}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: TR.text, width: 64, textAlign: 'right', flexShrink: 0 }}>
                    {formatUsd(model.cost)}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: TR.textDim, width: 44, textAlign: 'right', flexShrink: 0 }}>
                    {costShare > 0 ? `${Math.round(costShare)}%` : '—'}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12, color, width: 64, textAlign: 'right', flexShrink: 0 }}>
                    {arrow} {metric ? trendPct(metric.tokens_14d_prev, metric.tokens_14d_curr) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <Divider />
        <StatFooter
          stats={[
            { label: 'Distinct models', value: String(distinctModels) },
            { label: 'Top by cost', value: topCostModel?.name || '—', sub: topCostModel ? formatUsd(topCostModel.cost) : undefined, accent: Boolean(topCostModel) },
            { label: 'Top by sessions', value: topBySession || modelRows[0]?.name || '—' },
            { label: 'First model', value: firstModel?.name || '—', sub: firstModel?.date },
            { label: 'Latest model', value: latestModel?.name || '—', sub: latestModel?.date },
          ]}
        />
      </Card>
    </section>
  );
}
