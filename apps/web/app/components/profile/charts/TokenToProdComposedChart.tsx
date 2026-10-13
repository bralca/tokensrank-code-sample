'use client';

import { useMemo } from 'react';
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
import { ChartHydrationSkeleton } from './ChartHydrationSkeleton';
import { dateLabelDaysAgo, formatLoc, formatTokens } from './utils';

const SHIP_COLOR = '#F0A93C';
const ROLLING_DAYS = 7;

export type TokenToProdPoint = {
  date: string;
  daysAgo: number;
  id: string;
  loc: number;
  loc7d: number;
  tokens: number;
  tokens7d: number;
};

const LEGEND_ITEMS = [
  { label: 'Daily tokens', color: TR.accent, kind: 'bar' },
  { label: '7-day token trend', color: TR.accent, kind: 'line' },
  { label: '7-day shipped AI-coded LOC', color: SHIP_COLOR, kind: 'line' },
];

function padStart(values: number[], length: number): number[] {
  if (values.length >= length) {
    return values;
  }

  return [...new Array(length - values.length).fill(0), ...values];
}

function rollingSum(values: number[], index: number): number {
  const start = Math.max(0, index - ROLLING_DAYS + 1);
  let total = 0;

  for (let i = start; i <= index; i += 1) {
    total += values[i] ?? 0;
  }

  return total;
}

function normalizeSeries(dailyTokens: number[], shippedLoc: number[]): TokenToProdPoint[] {
  const length = Math.max(dailyTokens.length, shippedLoc.length, 1);
  const tokens = padStart(dailyTokens, length);
  const loc = padStart(shippedLoc, length);
  const visibleLength = Math.max(tokens.length, loc.length, 1);

  return Array.from({ length: visibleLength }, (_, index) => {
    const daysAgo = visibleLength - 1 - index;

    return {
      date: dateLabelDaysAgo(daysAgo),
      daysAgo,
      id: String(index),
      loc: Math.max(0, Math.trunc(loc[index] ?? 0)),
      loc7d: Math.max(0, Math.trunc(rollingSum(loc, index))),
      tokens: Math.max(0, Math.trunc(tokens[index] ?? 0)),
      tokens7d: Math.max(0, Math.trunc(rollingSum(tokens, index))),
    };
  });
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) {
    return null;
  }

  const point = payload[0]?.payload as TokenToProdPoint | undefined;

  if (!point) {
    return null;
  }

  const rows = [
    { label: 'Daily tokens', value: `${formatTokens(point.tokens)} tokens`, color: TR.accent },
	    { label: 'Daily shipped AI-coded', value: `${formatLoc(point.loc)} LOC`, color: SHIP_COLOR },
	    { label: '7d tokens', value: `${formatTokens(point.tokens7d)} tokens`, color: TR.accent },
	    { label: '7d shipped AI-coded', value: `${formatLoc(point.loc7d)} LOC`, color: SHIP_COLOR },
	  ];

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
        minWidth: 190,
        padding: '9px 12px',
      }}
    >
      <div style={{ color: TR.textDim, fontSize: 10.5, marginBottom: 8 }}>{point.date}</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {rows.map((row) => (
          <div
            key={row.label}
            style={{
              alignItems: 'baseline',
              display: 'flex',
              gap: 12,
              justifyContent: 'space-between',
            }}
          >
            <span style={{ color: row.color, fontSize: 10.5, textTransform: 'uppercase' }}>{row.label}</span>
            <span style={{ color: TR.text, fontWeight: 600 }}>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderChartTooltip(props: TooltipContentProps) {
  return <ChartTooltip {...props} />;
}

function ChartLegend() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginBottom: 12 }}>
      {LEGEND_ITEMS.map((item) => (
        <div key={item.label} style={{ alignItems: 'center', display: 'flex', gap: 7 }}>
          {item.kind === 'bar' ? (
            <span
              style={{
                background: item.color,
                borderRadius: 2,
                height: 9,
                opacity: 0.24,
                width: 12,
              }}
            />
          ) : (
            <span
              style={{
                background: item.color,
                borderRadius: 2,
                height: 2,
                width: 16,
              }}
            />
          )}
          <span style={{ color: TR.textMid, fontFamily: FONT_MONO, fontSize: 11 }}>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

export function buildTokenToProdData(dailyTokens: number[], shippedLoc: number[]): TokenToProdPoint[] {
  return normalizeSeries(dailyTokens, shippedLoc);
}

export function tokenToProdStats(data: TokenToProdPoint[]) {
  const totals = data.reduce(
    (current, point) => ({
      loc: current.loc + point.loc,
      overlapDays: current.overlapDays + (point.tokens > 0 && point.loc > 0 ? 1 : 0),
      shipDays: current.shipDays + (point.loc > 0 ? 1 : 0),
      tokenDays: current.tokenDays + (point.tokens > 0 ? 1 : 0),
      tokens: current.tokens + point.tokens,
    }),
    { loc: 0, overlapDays: 0, shipDays: 0, tokenDays: 0, tokens: 0 },
  );

	  return {
	    ...totals,
	  };
	}

export function TokenToProdComposedChart({
  data,
  height = 300,
}: {
  data: TokenToProdPoint[];
  height?: number;
}) {
  const tickValues = useMemo(() => {
    const tickStep = Math.max(1, Math.round(data.length / 6));

    return data
      .filter((_, index) => index % tickStep === 0 || index === data.length - 1)
      .map((point) => point.id);
  }, [data]);
  const latestPoint = data[data.length - 1];
  const resetKey = `${data.length}:${latestPoint?.tokens7d ?? 0}:${latestPoint?.loc7d ?? 0}`;

  return (
    <div style={{ width: '100%' }}>
      <ChartLegend />
      <ChartHydrationSkeleton height={height} resetKey={resetKey} variant="composed">
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
            data={data}
            margin={{ top: 12, right: 20, bottom: 26, left: 8 }}
          >
            <CartesianGrid stroke={TR.border} strokeDasharray="2 4" strokeOpacity={0.45} vertical={false} />
            <XAxis
              axisLine={{ stroke: TR.border }}
              dataKey="id"
              interval={0}
              minTickGap={24}
              tick={{ fill: TR.textDim, fontFamily: FONT_MONO, fontSize: 10 }}
              tickFormatter={(value) => data[Number(value)]?.date ?? ''}
              tickLine={false}
              ticks={tickValues}
            />
            <YAxis
              axisLine={false}
              domain={[0, 'dataMax']}
              tick={{ fill: TR.textDim, fontFamily: FONT_MONO, fontSize: 10 }}
              tickFormatter={(value) => formatTokens(Number(value))}
              tickLine={false}
              width={58}
              yAxisId="tokens"
            />
            <YAxis
              axisLine={false}
              domain={[0, 'dataMax']}
              orientation="right"
              tick={{ fill: TR.textDim, fontFamily: FONT_MONO, fontSize: 10 }}
              tickFormatter={(value) => formatLoc(Number(value))}
              tickLine={false}
              width={50}
              yAxisId="loc"
            />
            <Tooltip
              content={renderChartTooltip}
              cursor={{ fill: 'rgba(182, 255, 60, 0.045)', stroke: TR.borderHi, strokeWidth: 1 }}
            />
            <Bar
              dataKey="tokens"
              fill={TR.accent}
              fillOpacity={0.14}
              maxBarSize={9}
              name="Daily tokens"
              radius={[2, 2, 0, 0]}
              stroke={TR.accent}
              strokeOpacity={0.12}
              yAxisId="tokens"
            />
            <Line
              activeDot={{ fill: TR.accent, r: 3.5, stroke: TR.bgSoft, strokeWidth: 2 }}
              connectNulls
              dataKey="tokens7d"
              dot={false}
              name="7-day token trend"
              stroke={TR.accent}
              strokeOpacity={0.95}
              strokeWidth={1.8}
              type="monotone"
              yAxisId="tokens"
            />
            <Line
              activeDot={{ fill: SHIP_COLOR, r: 4, stroke: TR.bgSoft, strokeWidth: 2 }}
              connectNulls
              dataKey="loc7d"
              dot={false}
              name="7-day shipped AI-coded LOC"
              stroke={SHIP_COLOR}
              strokeWidth={2.25}
              type="monotone"
              yAxisId="loc"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartHydrationSkeleton>
    </div>
  );
}
