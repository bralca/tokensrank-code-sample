'use client';

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { TR } from '@/lib/design-tokens';

type ChartSkeletonVariant = 'area' | 'bar' | 'calendar' | 'composed';

interface ChartHydrationSkeletonProps {
  children: ReactNode;
  height: number;
  resetKey?: string | number;
  variant?: ChartSkeletonVariant;
}

const CHART_CONTENT_SELECTOR = 'svg path, svg rect, svg circle, svg line, svg text, svg polyline, svg polygon';

function ShimmerBlock({
  className = '',
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={`tr-skeleton-shimmer ${className}`}
      style={{
        background: TR.bgRow,
        borderRadius: 2,
        display: 'block',
        ...style,
      }}
    />
  );
}

function GridLines() {
  return (
    <>
      {[18, 45, 72].map((top) => (
        <span
          key={top}
          aria-hidden="true"
          style={{
            borderTop: `1px dashed ${TR.border}`,
            left: 0,
            opacity: 0.8,
            position: 'absolute',
            right: 0,
            top: `${top}%`,
          }}
        />
      ))}
    </>
  );
}

function BarSkeleton({ dense = false }: { dense?: boolean }) {
  const count = dense ? 52 : 24;

  return (
    <div style={{ alignItems: 'flex-end', bottom: 22, display: 'flex', gap: 3, left: 0, position: 'absolute', right: 0, top: 38 }}>
      {Array.from({ length: count }, (_, index) => {
        const height = index % 11 === 0 ? 78 : index % 7 === 0 ? 58 : index % 5 === 0 ? 42 : index % 3 === 0 ? 28 : 16;

        return <ShimmerBlock key={index} style={{ flex: 1, height: `${height}%`, maxHeight: 92, minWidth: 0, opacity: 0.72 }} />;
      })}
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'grid',
        gap: 3,
        gridTemplateColumns: 'repeat(26, minmax(0, 1fr))',
        gridTemplateRows: 'repeat(7, 1fr)',
        height: '100%',
        padding: '18px 8px 18px 22px',
      }}
    >
      {Array.from({ length: 26 * 7 }, (_, index) => (
        <ShimmerBlock
          key={index}
          style={{
            aspectRatio: '1 / 1',
            opacity: index % 13 === 0 ? 0.92 : index % 5 === 0 ? 0.68 : 0.42,
            width: '100%',
          }}
        />
      ))}
    </div>
  );
}

function ChartSkeleton({ variant }: { variant: ChartSkeletonVariant }) {
  if (variant === 'calendar') {
    return <CalendarSkeleton />;
  }

  return (
    <div aria-hidden="true" style={{ height: '100%', position: 'relative', width: '100%' }}>
      <GridLines />
      {variant === 'bar' ? <BarSkeleton dense /> : null}
      {variant === 'composed' ? (
        <BarSkeleton dense />
      ) : null}
      {variant === 'area' ? (
        <BarSkeleton />
      ) : null}
    </div>
  );
}

function hasRenderedChart(node: HTMLDivElement | null) {
  const svg = node?.querySelector('svg');

  if (!svg) {
    return false;
  }

  const bounds = svg.getBoundingClientRect();

  if (bounds.width <= 0 || bounds.height <= 0) {
    return false;
  }

  return Boolean(svg.querySelector(CHART_CONTENT_SELECTOR));
}

export function ChartHydrationSkeleton({
  children,
  height,
  resetKey,
  variant = 'bar',
}: ChartHydrationSkeletonProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const node = chartRef.current;
    let animationFrame = 0;
    let timeout = 0;

    setIsReady(false);

    const check = () => {
      if (hasRenderedChart(node)) {
        setIsReady(true);
        return;
      }

      animationFrame = window.requestAnimationFrame(check);
    };

    const observer = new MutationObserver(check);

    if (node) {
      observer.observe(node, { attributes: true, childList: true, subtree: true });
    }

    animationFrame = window.requestAnimationFrame(check);
    timeout = window.setTimeout(() => setIsReady(true), 8000);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(timeout);
    };
  }, [resetKey]);

  return (
    <div style={{ height, position: 'relative', width: '100%' }}>
      <div
        ref={chartRef}
        style={{
          height: '100%',
          opacity: isReady ? 1 : 0,
          transition: 'opacity 180ms ease',
          width: '100%',
        }}
      >
        {children}
      </div>
      {!isReady ? (
        <div
          style={{
            inset: 0,
            padding: '12px 14px 24px 44px',
            pointerEvents: 'none',
            position: 'absolute',
          }}
        >
          <ChartSkeleton variant={variant} />
        </div>
      ) : null}
    </div>
  );
}
