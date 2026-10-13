'use client';

import { TR } from '@/lib/design-tokens';

export interface ChartTheme {
  barColor: string;
  lineColor: string;
  areaColor: string;
  gridlineColor: string;
  textColor: string;
  backgroundColor: string;
  accentColor: string;
  downColor: string;
  flatColor: string;
}

export function useChartTheme(): ChartTheme {
  return {
    // Main accent for bars and primary visual elements
    barColor: TR.accent,
    lineColor: TR.accent,
    areaColor: TR.accent,
    // Grid and structure
    gridlineColor: TR.border,
    // Text and labels
    textColor: TR.text,
    // Backgrounds
    backgroundColor: TR.bg,
    // Additional accent colors for trends
    accentColor: TR.accent,
    downColor: TR.down,
    flatColor: TR.flat,
  };
}
