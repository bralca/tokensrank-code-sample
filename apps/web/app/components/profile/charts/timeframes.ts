export type ChartTimeframe = '24h' | '7d' | '30d' | 'all';

export const CHART_TIMEFRAME_OPTIONS: Array<{ value: ChartTimeframe; label: string; description: string }> = [
  { value: '24h', label: '24H', description: 'Last 24 hours' },
  { value: '7d', label: '7D', description: 'Last 7 days' },
  { value: '30d', label: '30D', description: 'Last 30 days' },
  { value: 'all', label: 'ALL', description: 'All available data' },
];

export function timeframeDays(timeframe: ChartTimeframe): number | null {
  switch (timeframe) {
    case '24h':
      return 1;
    case '7d':
      return 7;
    case '30d':
      return 30;
    case 'all':
      return null;
  }
}

export function timeframeDisplayLabel(timeframe: ChartTimeframe): string {
  switch (timeframe) {
    case '24h':
      return 'last 24h';
    case '7d':
      return 'last 7 days';
    case '30d':
      return 'last 30 days';
    case 'all':
      return 'all time';
  }
}

export function sliceSeriesByTimeframe<T>(values: T[], timeframe: ChartTimeframe): T[] {
  const days = timeframeDays(timeframe);

  if (days === null) {
    return values;
  }

  return values.slice(-days);
}

