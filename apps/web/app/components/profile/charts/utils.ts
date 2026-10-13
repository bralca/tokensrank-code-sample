/** Shared chart formatting + date helpers for the Nivo profile charts. */

export function formatTokens(value: number): string {
  if (!value || value <= 0) return '0';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(value));
}

export function formatLoc(value: number): string {
  if (!value || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(value));
}

export function formatUsd(value: number): string {
  if (!value || value <= 0) return '$0';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/u, '')}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1).replace(/\.0$/u, '')}K`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** ISO YYYY-MM-DD for the UTC day `daysAgo` days before today (0 = today). */
export function isoDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Human label "Mar 4" for `daysAgo` days before today. */
export function dateLabelDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Map an oldest→newest day array (last element = today) to Nivo calendar data. */
export function arrayToCalendar(values: number[]): Array<{ day: string; value: number }> {
  const n = values.length;
  return values.map((value, i) => ({ day: isoDaysAgo(n - 1 - i), value: value || 0 }));
}

/** First/last ISO dates spanning an N-day oldest→newest array. */
export function calendarRange(length: number): { from: string; to: string } {
  return { from: isoDaysAgo(length - 1), to: isoDaysAgo(0) };
}

export function relativeDayLabel(daysAgo: number): string {
  if (daysAgo <= 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  return `${daysAgo}d ago`;
}
