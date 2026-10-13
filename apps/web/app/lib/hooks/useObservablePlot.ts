'use client';

import { useEffect, useRef } from 'react';
import * as Plot from '@observablehq/plot';

interface UseObservablePlotOptions {
  width?: number | string;
  height?: number | string;
  margin?: { top?: number; right?: number; bottom?: number; left?: number };
}

export function useObservablePlot(
  renderFn: (container: HTMLDivElement) => void,
  options?: UseObservablePlotOptions,
) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Clear previous content
    containerRef.current.innerHTML = '';

    // Render the plot
    try {
      renderFn(containerRef.current);
    } catch (error) {
      console.error('Error rendering Observable Plot:', error);
    }
  }, [renderFn]);

  return containerRef;
}

export { Plot };
