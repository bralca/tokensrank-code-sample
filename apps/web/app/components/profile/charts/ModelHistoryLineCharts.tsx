'use client';

import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import {
  getDistinctModelColor,
  PROVIDER_COLOR,
  PROVIDER_LABEL,
} from '@/lib/nivo-theme';
import { ChartHydrationSkeleton } from './ChartHydrationSkeleton';
import { formatTokens, formatUsd } from './utils';
import { timeframeDays, type ChartTimeframe } from './timeframes';

export interface ProviderSpendHistoryItem {
  provider: 'claude' | 'codex' | 'opencode' | 'other';
  points: Array<{
    date: string;
    cost: number;
  }>;
}

export interface ModelUsageHistoryItem {
  model: string;
  points: Array<{
    date: string;
    cost?: number;
    tokens: number;
  }>;
}

type LinePoint = { x: string; y: number };
type LineSeries = {
  id: string;
  key: string;
  color: string;
  data: LinePoint[];
};
type ChartDatum = {
  id: string;
  date: string;
  dateLabel: string;
  totalAverage: number;
  [key: string]: string | number | null;
};
type BuiltChartData = {
  data: ChartDatum[];
  series: LineSeries[];
};
type ChartTooltipPayload = TooltipContentProps['payload'];
type ChartMode = 'absolute' | 'share';

const MAX_TOOLTIP_ROWS = 9;
const MOVING_AVERAGE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TOTAL_COLOR = TR.text;

function formatDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatAxisDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function dateToUtcMs(date: string): number {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dateRange(cutoff: number, latest: number): string[] {
  const dates: string[] = [];

  for (let timestamp = cutoff; timestamp <= latest; timestamp += MS_PER_DAY) {
    dates.push(isoDate(timestamp));
  }

  return dates;
}

function latestTimestamp(points: LinePoint[]): number {
  return Math.max(0, ...points.map((point) => dateToUtcMs(point.x)));
}

function cutoffForTimeframe(earliest: number, latest: number, timeframe: ChartTimeframe): number {
  const days = timeframeDays(timeframe);

  if (days === null) {
    return earliest;
  }

  return latest - ((days - 1) * MS_PER_DAY);
}

function dailyFromCumulative(points: LinePoint[]): LinePoint[] {
  let previousTotal = 0;

  return points.map((point) => {
    const dailyValue = Math.max(0, point.y - previousTotal);

    previousTotal = point.y;

    return { x: point.x, y: dailyValue };
  });
}

function movingAverageFromDaily(points: LinePoint[]): LinePoint[] {
  const windowValues: number[] = [];
  let windowTotal = 0;

  return points.map((point) => {
    windowValues.push(point.y);
    windowTotal += point.y;

    if (windowValues.length > MOVING_AVERAGE_DAYS) {
      windowTotal -= windowValues.shift() ?? 0;
    }

    return { x: point.x, y: windowTotal / windowValues.length };
  });
}

function trimInactiveEdges(points: LinePoint[]): LinePoint[] {
  const firstActiveIndex = points.findIndex((point) => point.y > 0);

  if (firstActiveIndex === -1) {
    return [];
  }

  let lastActiveIndex = points.length - 1;

  while (lastActiveIndex > firstActiveIndex && points[lastActiveIndex]?.y <= 0) {
    lastActiveIndex -= 1;
  }

  return points.slice(firstActiveIndex, lastActiveIndex + 1);
}

function cropPoints(points: LinePoint[], cutoff: number): LinePoint[] {
  return points.filter((point) => dateToUtcMs(point.x) >= cutoff);
}

function buildComposedData(
  items: Array<{ id: string; color: string; cumulative: LinePoint[] }>,
  timeframe: ChartTimeframe,
  mode: ChartMode = 'absolute',
): BuiltChartData {
  const dailyBySeries = items.map((item) => ({
    ...item,
    daily: dailyFromCumulative(item.cumulative),
  }));
  const latest = Math.max(0, ...dailyBySeries.map((item) => latestTimestamp(item.daily)));
  const earliest = Math.min(
    latest,
    ...dailyBySeries.flatMap((item) => item.daily.map((point) => dateToUtcMs(point.x)).filter((value) => value > 0)),
  );

  if (latest <= 0) {
    return { data: [], series: [] };
  }

  const cutoff = cutoffForTimeframe(earliest, latest, timeframe);
  const series = dailyBySeries
    .map<LineSeries>((item, index) => ({
      color: item.color,
      data: trimInactiveEdges(cropPoints(movingAverageFromDaily(item.daily), cutoff)),
      id: item.id,
      key: `series_${index}`,
    }))
    .filter((item) => item.data.length > 0);
  const seriesPointMaps = series.map((item) => ({
    key: item.key,
    points: new Map(item.data.map((point) => [point.x, point.y])),
  }));
  const data = dateRange(cutoff, latest).map<ChartDatum>((date, index) => {
    const datum: ChartDatum = {
      date,
      dateLabel: formatAxisDate(date),
      id: String(index),
      totalAverage: 0,
    };

    for (const item of seriesPointMaps) {
      const value = item.points.get(date) ?? 0;

      datum[`${item.key}_raw`] = value;
      datum[item.key] = value;
      datum.totalAverage += value;
    }

    if (mode === 'share') {
      for (const item of seriesPointMaps) {
        const value = Number(datum[`${item.key}_raw`] ?? 0);

        datum[item.key] = datum.totalAverage > 0 ? (value / datum.totalAverage) * 100 : 0;
      }
    }

    return datum;
  });

  return { data, series };
}

function buildResetKey(chartData: BuiltChartData) {
  const latest = chartData.data.at(-1);
  const latestSeriesValues = chartData.series
    .map((item) => `${item.id}:${latest?.[item.key] ?? 0}`)
    .join('|');

  return `${chartData.data.length}:${latest?.totalAverage ?? 0}:${latestSeriesValues}`;
}

function ChartLegend({
  series,
}: {
  series: LineSeries[];
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginBottom: 12 }}>
      {series.map((item) => (
        <div key={item.key} style={{ alignItems: 'center', display: 'flex', gap: 7, minWidth: 0 }}>
          <span
            style={{
              background: item.color,
              borderRadius: 2,
              height: 9,
              opacity: 0.75,
              width: 12,
            }}
          />
          <span
            style={{
              color: TR.textMid,
              fontFamily: FONT_MONO,
              fontSize: 11,
              maxWidth: 170,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.id}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChartTooltip({
  active,
  mode,
  payload,
  totalLabel,
  valueFormatter,
}: {
  active?: boolean;
  mode: ChartMode;
  payload?: ChartTooltipPayload;
  totalLabel: string;
  valueFormatter: (value: number) => string;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const point = payload[0]?.payload as ChartDatum | undefined;

  if (!point) {
    return null;
  }

  const totalRow = point.totalAverage > 0
    ? [{ color: TOTAL_COLOR, label: totalLabel, value: point.totalAverage }]
    : [];
  const lineRows = payload
    .filter((item) => item.dataKey !== 'totalAverage' && typeof item.value === 'number' && item.value > 0)
    .map((item) => ({
      color: String(item.color ?? TR.textMid),
      label: String(item.name ?? item.dataKey ?? ''),
      share: Number(item.value),
      value: mode === 'share'
        ? Number(point[`${String(item.dataKey)}_raw`] ?? 0)
        : Number(item.value),
    }))
    .filter((item) => item.label.trim() !== '')
    .sort((left, right) => right.value - left.value)
    .slice(0, MAX_TOOLTIP_ROWS);
  const rows = [...totalRow, ...lineRows];

  if (rows.length === 0) {
    return null;
  }

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
        minWidth: 230,
        padding: '8px 12px',
      }}
    >
      <div style={{ color: TR.textDim, fontSize: 10.5, marginBottom: 7 }}>{formatDate(point.date)}</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {rows.map((row) => (
          <div key={row.label} style={{ alignItems: 'center', display: 'flex', gap: 10, justifyContent: 'space-between' }}>
            <span style={{ alignItems: 'center', color: TR.textMid, display: 'flex', gap: 6, minWidth: 0 }}>
              <span style={{ background: row.color, borderRadius: 2, height: 8, width: 10 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
            </span>
            <span style={{ color: TR.text, fontWeight: 600, whiteSpace: 'nowrap' }}>
              {'share' in row && mode === 'share'
                ? `${Math.round(Number(row.share))}% · ${valueFormatter(row.value)}`
                : valueFormatter(row.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryStackedAreaChart({
  chartData,
  formatter,
  height,
  mode = 'absolute',
  totalLabel,
}: {
  chartData: BuiltChartData;
  formatter: (value: number) => string;
  height: number;
  mode?: ChartMode;
  totalLabel: string;
}) {
  const tickValues = useMemo(() => {
    const tickStep = Math.max(1, Math.round(chartData.data.length / 6));

    return chartData.data
      .filter((_, index) => index % tickStep === 0 || index === chartData.data.length - 1)
      .map((point) => point.id);
  }, [chartData.data]);
  const resetKey = buildResetKey(chartData);

  return (
    <div style={{ width: '100%' }}>
      <ChartLegend series={chartData.series} />
      <ChartHydrationSkeleton height={height} resetKey={resetKey} variant="area">
        <ResponsiveContainer
          height="100%"
          initialDimension={{ height, width: 800 }}
          minHeight={height}
          minWidth={0}
          width="100%"
        >
          <ComposedChart
            accessibilityLayer
            barCategoryGap="18%"
            data={chartData.data}
            margin={{ top: 10, right: 20, bottom: 26, left: 8 }}
          >
            <CartesianGrid stroke={TR.border} strokeDasharray="2 4" strokeOpacity={0.45} vertical={false} />
            <XAxis
              axisLine={{ stroke: TR.border }}
              dataKey="id"
              interval={0}
              minTickGap={24}
              tick={{ fill: TR.textDim, fontFamily: FONT_MONO, fontSize: 10 }}
              tickFormatter={(value) => chartData.data[Number(value)]?.dateLabel ?? ''}
              tickLine={false}
              ticks={tickValues}
            />
            <YAxis
              axisLine={false}
              domain={mode === 'share' ? [0, 100] : [0, 'dataMax']}
              ticks={mode === 'share' ? [0, 25, 50, 75, 100] : undefined}
              tick={{ fill: TR.textDim, fontFamily: FONT_MONO, fontSize: 10 }}
              tickFormatter={(value) => mode === 'share' ? `${Math.round(Number(value))}%` : formatter(Number(value))}
              tickLine={false}
              width={60}
            />
            <Tooltip
              content={(props) => (
                <ChartTooltip
                  active={props.active}
                  mode={mode}
                  payload={props.payload}
                  totalLabel={totalLabel}
                  valueFormatter={formatter}
                />
              )}
              cursor={{ fill: 'rgba(182, 255, 60, 0.045)', stroke: TR.borderHi, strokeWidth: 1 }}
            />
            {chartData.series.map((item) => (
              <Area
                activeDot={{ fill: item.color, r: 3.5, stroke: TR.bgSoft, strokeWidth: 2 }}
                dataKey={item.key}
                fill={item.color}
                fillOpacity={mode === 'share' ? 0.48 : 0.34}
                key={item.key}
                name={item.id}
                stackId="moving_average"
                stroke={item.color}
                strokeOpacity={0.95}
                strokeWidth={1.7}
                type="monotone"
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartHydrationSkeleton>
    </div>
  );
}

export function ProviderSpendHistoryChart({
  history,
  height = 240,
  mode = 'absolute',
  timeframe = '30d',
}: {
  history: ProviderSpendHistoryItem[];
  height?: number;
  mode?: ChartMode;
  timeframe?: ChartTimeframe;
}) {
  const chartData = useMemo(
    () => buildComposedData(
      history.map((item) => ({
        color: PROVIDER_COLOR[item.provider],
        cumulative: item.points.map((point) => ({ x: point.date, y: point.cost })),
        id: PROVIDER_LABEL[item.provider],
      })),
      timeframe,
      mode,
    ),
    [history, mode, timeframe],
  );

  if (chartData.data.length === 0 || chartData.series.length === 0) {
    return null;
  }

  return (
    <HistoryStackedAreaChart
      chartData={chartData}
      formatter={formatUsd}
      height={height}
      mode={mode}
      totalLabel="Total 7-day avg"
    />
  );
}

export function ModelUsageHistoryChart({
  history,
  height = 300,
  mode = 'absolute',
  timeframe = '30d',
}: {
  history: ModelUsageHistoryItem[];
  height?: number;
  mode?: ChartMode;
  timeframe?: ChartTimeframe;
}) {
  const chartData = useMemo(
    () => buildComposedData(
      history.map((item) => ({
        color: getDistinctModelColor(item.model),
        cumulative: item.points.map((point) => ({ x: point.date, y: point.tokens })),
        id: item.model,
      })),
      timeframe,
      mode,
    ),
    [history, mode, timeframe],
  );

  if (chartData.data.length === 0 || chartData.series.length === 0) {
    return null;
  }

  return (
    <HistoryStackedAreaChart
      chartData={chartData}
      formatter={formatTokens}
      height={height}
      mode={mode}
      totalLabel="Total 7-day avg"
    />
  );
}
