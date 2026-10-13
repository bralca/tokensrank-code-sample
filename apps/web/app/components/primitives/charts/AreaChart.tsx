'use client';

import { useEffect, useRef, useState } from 'react';
import * as Plot from '@observablehq/plot';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { useChartTheme } from '@/lib/hooks/useChartTheme';

export interface AreaChartProps {
  data: Array<{ x: number | string; y: number }>;
  width?: number;
  height?: number;
  showLine?: boolean;
  showArea?: boolean;
  showGridline?: boolean;
  showAxis?: boolean;
  color?: string;
  peakValue?: number;
  peakDate?: string | number;
  peakLabel?: string;
  yTickFormatter?: (value: number) => string;
  responsive?: boolean;
}

export function AreaChart({
  data,
  width: widthProp = 400,
  height = 200,
  showLine = true,
  showArea = true,
  showGridline = true,
  showAxis = true,
  color,
  peakValue,
  peakDate,
  peakLabel,
  yTickFormatter,
  responsive = false,
}: AreaChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useChartTheme();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  // Track container width when responsive
  useEffect(() => {
    if (!responsive || !containerRef.current) return;

    const element = containerRef.current;
    const update = () => {
      const next = Math.max(0, Math.floor(element.clientWidth));
      if (next > 0) setMeasuredWidth(next);
    };
    update();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [responsive]);

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return;

    const width = responsive ? (measuredWidth ?? widthProp) : widthProp;
    if (responsive && !measuredWidth) return; // wait for first measurement

    containerRef.current.innerHTML = '';

    try {
      const validData = data.filter((d) => d && typeof d.x !== 'undefined' && typeof d.y !== 'undefined');
      if (validData.length === 0) return;

      const maxY = Math.max(...validData.map((d) => d.y), peakValue || 0);
      const marks: any[] = [];

      if (showGridline) {
        marks.push(
          Plot.gridY({
            stroke: theme.gridlineColor,
            strokeOpacity: 0.15,
            strokeDasharray: '2,3',
          }),
        );
      }

      if (showArea) {
        marks.push(
          Plot.areaY(validData as any, {
            x: 'x',
            y: 'y',
            fill: color || theme.areaColor,
            fillOpacity: 0.12,
            curve: 'monotone-x',
          } as any),
        );
      }

      if (showLine) {
        marks.push(
          Plot.line(validData as any, {
            x: 'x',
            y: 'y',
            stroke: color || theme.lineColor,
            strokeWidth: 2,
            curve: 'monotone-x',
          }),
        );
      }

      // Peak marker: vertical dotted line + dot + label
      if (peakValue !== undefined && peakDate !== undefined) {
        const peakDataPoint = validData.find((d) => d.x === peakDate);
        if (peakDataPoint) {
          // Vertical dotted line from peak down to x-axis
          marks.push(
            Plot.ruleX([peakDataPoint], {
              x: 'x',
              stroke: color || theme.accentColor,
              strokeOpacity: 0.5,
              strokeDasharray: '2,3',
              strokeWidth: 1,
            } as any),
          );
          // Outer ring (white) + inner dot
          marks.push(
            Plot.dot([peakDataPoint], {
              x: 'x',
              y: 'y',
              fill: color || theme.accentColor,
              stroke: TR.bgSoft,
              strokeWidth: 3,
              r: 5,
            } as any),
          );
          // Label above the point
          if (peakLabel) {
            marks.push(
              Plot.text([peakDataPoint], {
                x: 'x',
                y: 'y',
                text: () => peakLabel,
                dy: -14,
                fontSize: 11,
                fontFamily: FONT_MONO,
                fill: theme.textColor,
                textAnchor: 'middle',
              } as any),
            );
          }
        }
      }

      const yScale: Record<string, unknown> = {
        domain: [0, maxY * 1.08],
        label: null,
        ticks: 5,
      };
      if (yTickFormatter) {
        yScale.tickFormat = yTickFormatter;
      }

      const xScale: Record<string, unknown> = {
        type: typeof validData[0]?.x === 'number' ? 'linear' : 'band',
        label: null,
      };
      if (!showAxis) {
        xScale.axis = null;
      }

      const plot = Plot.plot({
        width,
        height,
        marginTop: 24,
        marginRight: 24,
        marginBottom: showAxis ? 26 : 8,
        marginLeft: 56,
        style: {
          fontSize: 11,
          fontFamily: FONT_MONO,
          color: theme.textColor,
          background: 'transparent',
        },
        x: xScale,
        y: yScale,
        marks,
      } as any);

      containerRef.current.appendChild(plot);
    } catch (error) {
      console.error('Error rendering AreaChart:', error);
    }
  }, [
    data,
    widthProp,
    measuredWidth,
    responsive,
    height,
    showLine,
    showArea,
    showGridline,
    showAxis,
    color,
    peakValue,
    peakDate,
    peakLabel,
    yTickFormatter,
    theme,
  ]);

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
