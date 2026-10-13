import { formatCost, formatTokens } from '../lib/og-loader';

export function formatOGTokens(value: number): string {
  return formatTokens(value);
}

export function formatOGCost(value: number | null | undefined): string {
  return formatCost(value);
}
