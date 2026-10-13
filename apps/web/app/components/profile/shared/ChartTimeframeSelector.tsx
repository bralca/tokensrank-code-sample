'use client';

import { TR, FONT_MONO } from '@/lib/design-tokens';
import {
  CHART_TIMEFRAME_OPTIONS,
  type ChartTimeframe,
} from '../charts/timeframes';

interface ChartTimeframeSelectorProps {
  value: ChartTimeframe;
  onChange: (value: ChartTimeframe) => void;
}

export function ChartTimeframeSelector({ value, onChange }: ChartTimeframeSelectorProps) {
  return (
    <div
      aria-label="Chart timeframe"
      role="radiogroup"
      style={{
        alignItems: 'center',
        background: TR.bgRow,
        border: `1px solid ${TR.border}`,
        borderRadius: 999,
        display: 'inline-flex',
        gap: 2,
        padding: 3,
      }}
    >
      {CHART_TIMEFRAME_OPTIONS.map((option) => {
        const isActive = option.value === value;

        return (
          <button
            aria-checked={isActive}
            aria-label={option.description}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="radio"
            title={option.description}
            type="button"
            style={{
              appearance: 'none',
              background: isActive ? TR.accent : 'transparent',
              border: 0,
              borderRadius: 999,
              color: isActive ? TR.bg : TR.textMid,
              cursor: 'pointer',
              fontFamily: FONT_MONO,
              fontSize: 10,
              fontWeight: 700,
              height: 24,
              letterSpacing: '0.04em',
              lineHeight: '24px',
              minWidth: option.value === 'all' ? 42 : 34,
              padding: '0 10px',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

