/**
 * Format helpers for TokensRank
 * All values match design spec examples exactly
 */

/**
 * Format token count with B/M/K suffixes
 * 1.84e9 -> "1.84B"
 * 847e6 -> "847M"
 * 124e3 -> "124K"
 * 42 -> "42"
 */
export function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(Math.round(n));
}

/**
 * Format USD currency
 * 32400 -> "$32,400"
 * 1240 -> "$1,240"
 * 8.42 -> "$8"
 */
export function fmtUSD(n: number): string {
  return '$' + Math.round(n).toLocaleString();
}

/**
 * Format decimal to percentage
 * 0.74 -> "74%"
 * 0.785 with decimals=1 -> "78.5%"
 * 0.08 -> "8%"
 */
export function fmtPct(n: number, decimals = 0): string {
  return `${(n * 100).toFixed(decimals)}%`;
}

/**
 * Format milliseconds to duration string
 * 15120000 (4h 12m) -> "4h 12m"
 * 2280000 (38m) -> "38m"
 * 3600000 (1h) -> "1h"
 */
export function fmtDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * Format rank delta with arrow
 * 12 -> "↑12"
 * -3 -> "↓3"
 * 0 or null -> "—"
 */
export function fmtDelta(value: number | null | undefined): string {
  if (value === 0 || value == null) return '—';
  const up = value > 0;
  const arrow = up ? '↑' : '↓';
  return `${arrow}${Math.abs(value)}`;
}

/**
 * Format large number with comma separators
 * 41920 -> "41,920"
 * 1000000 -> "1,000,000"
 */
export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString();
}

/**
 * Format session cost to 2 decimal places
 * 8.42 -> "$8.42"
 * 0.92 -> "$0.92"
 * 14.30 -> "$14.30"
 */
export function fmtCost(n: number): string {
  return '$' + n.toFixed(2);
}

/**
 * Format time string HH:MM from Date or time string
 * new Date('2026-04-30T14:32:00') -> "14:32"
 * "14:32" -> "14:32"
 */
export function fmtTime(time: Date | string): string {
  if (typeof time === 'string') return time;
  return time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Format day label from Date or string
 * new Date('2026-04-30') -> "Today" (if today)
 * new Date('2026-04-29') -> "Yesterday" (if yesterday)
 * new Date('2026-04-20') -> "Apr 20"
 * "Today" -> "Today"
 */
export function fmtDay(date: Date | string, today?: Date): string {
  if (typeof date === 'string') return date;

  const todayDate = today || new Date();
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const todayOnly = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());

  const diff = Math.floor((todayOnly.getTime() - dateOnly.getTime()) / (1000 * 60 * 60 * 24));

  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format model name to display (e.g., remove version suffixes if needed)
 * "sonnet-4-5" -> "sonnet-4-5" (no change in this spec)
 * "gpt-5-codex" -> "gpt-5-codex"
 */
export function fmtModel(name: string): string {
  return name;
}

/**
 * Format OS name to monogram
 * "mac" -> "⌘"
 * "linux" -> "L"
 * "windows" -> "⊞"
 */
export function fmtOSMonogram(os: string): string {
  const map: Record<string, string> = {
    mac: '⌘',
    linux: 'L',
    windows: '⊞',
  };
  return map[os] || '·';
}
