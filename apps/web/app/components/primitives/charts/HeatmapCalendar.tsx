'use client';

import { useRef, useEffect } from 'react';
import * as Plot from '@observablehq/plot';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { useChartTheme } from '@/lib/hooks/useChartTheme';

export interface HeatmapCalendarProps {
  data: Array<{ week: number; day: number; value: number; label?: string }>;
  width?: number;
  height?: number;
  colorScheme?: 'accent' | 'grayscale';
  showLabels?: boolean;
}

export function HeatmapCalendar({
  data,
  width = 360,
  height = 140,
  colorScheme = 'accent',
  showLabels = false,
}: HeatmapCalendarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme();

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return;

    containerRef.current.innerHTML = '';

    try {
      const maxValue = Math.max(...data.map((d) => d.value), 1);

      // Create color scale
      const getColor = (value: number) => {
        if (value === 0) return TR.border;

        const intensity = value / maxValue;

        if (colorScheme === 'accent') {
          // Gradient from dim border to bright accent
          if (intensity < 0.33) {
            return TR.borderHi; // Light border
          } else if (intensity < 0.66) {
            return TR.textDim; // Medium
          } else {
            return theme.accentColor; // Bright
          }
        } else {
          // Grayscale
          if (intensity < 0.33) {
            return TR.textDim;
          } else if (intensity < 0.66) {
            return TR.textMid;
          } else {
            return TR.text;
          }
        }
      };

      const marks: any[] = [
        Plot.cell(data as any, {
          x: 'week',
          y: 'day',
          fill: (d: any) => getColor(d.value),
          stroke: TR.bg,
          strokeWidth: 1,
        } as any),
      ];

      const plot = Plot.plot({
        width: width as number,
        height: height as number,
        marginTop: 10,
        marginRight: 10,
        marginBottom: 10,
        marginLeft: 10,
        style: { fontSize: 11, fontFamily: FONT_MONO },
        x: {
          type: 'band',
          domain: Array.from({ length: 13 }, (_, i) => i),
          axis: null,
        },
        y: {
          type: 'band',
          domain: Array.from({ length: 7 }, (_, i) => i),
          axis: null,
        },
        marks,
      } as any);

      containerRef.current.appendChild(plot);
    } catch (error) {
      console.error('Error rendering HeatmapCalendar:', error);
    }
  }, [data, width, height, colorScheme, showLabels, theme]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    />
  );
}
