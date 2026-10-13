'use client';

import { useRef, useEffect } from 'react';
import * as Plot from '@observablehq/plot';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { useChartTheme } from '@/lib/hooks/useChartTheme';

export interface BarChartProps {
  data: Array<{ x: number | string; y: number }>;
  width?: number;
  height?: number;
  barWidth?: number;
  gap?: number;
  showAxis?: boolean;
  showGridline?: boolean;
  color?: string;
  label?: string;
  valueLabel?: string;
}

export function BarChart({
  data,
  width = 400,
  height = 100,
  barWidth = 1,
  gap = 1,
  showAxis = false,
  showGridline = false,
  color,
  label,
  valueLabel,
}: BarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme();

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return;

    containerRef.current.innerHTML = '';

    try {
      // Validate data has proper structure
      const validData = data.filter((d) => d && typeof d.y !== 'undefined' && typeof d.y === 'number');
      if (validData.length === 0) return;

      const maxY = Math.max(...validData.map((d) => d.y), 1);
      const marks: any[] = [];

      if (showGridline) {
        marks.push(
          Plot.gridY({
            stroke: theme.gridlineColor,
            strokeOpacity: 0.1,
          })
        );
      }

      marks.push(
        Plot.barY(validData as any, {
          x: (_, i: number) => i,
          y: 'y',
          fill: color || theme.barColor,
          stroke: 'none',
        })
      );

      const plot = Plot.plot({
        width: width as number,
        height: height as number,
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
        marginLeft: 0,
        style: { fontSize: 12, fontFamily: FONT_MONO },
        x: {
          type: 'band',
          domain: validData.map((_, i) => i),
          range: [0, width as number],
          padding: gap ? gap / (width as number) : 0.1,
        },
        y: {
          domain: [0, maxY],
          range: [height as number, 0],
        },
        marks,
      } as any);

      containerRef.current.appendChild(plot);
    } catch (error) {
      console.error('Error rendering BarChart:', error);
    }
  }, [data, width, height, barWidth, gap, showAxis, showGridline, color, theme]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {label && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: TR.textMid,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontFamily: FONT_MONO,
          }}
        >
          {label}
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      />
      {valueLabel && (
        <div
          style={{
            fontSize: 12,
            color: TR.textMid,
            textAlign: 'center',
          }}
        >
          {valueLabel}
        </div>
      )}
    </div>
  );
}
