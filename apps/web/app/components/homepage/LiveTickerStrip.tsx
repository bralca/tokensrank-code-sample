'use client';

import { TR, LAYOUT, FONT_MONO, SPACING } from '@/lib/design-tokens';
import { LiveDot } from '@/components/primitives/LiveDot';

interface LiveTickerStripProps {
  connected: number;
  tokens24h: number;
  cost24h: number;
  recordsToday: number;
  updatedAt?: string;
}

function formatTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

function formatUSD(n: number): string {
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}

export function LiveTickerStrip({
  connected = 41920,
  tokens24h = 847e9,
  cost24h = 3.2e6,
  recordsToday = 12,
  updatedAt = 'now',
}: LiveTickerStripProps) {
  return (
    <div
      style={{
        padding: `${SPACING.sm}px ${LAYOUT.contentPadding}px`,
        borderBottom: `1px solid ${TR.border}`,
        display: 'flex',
        gap: 22,
        fontSize: 12.5,
        color: TR.textMid,
        alignItems: 'center',
        whiteSpace: 'nowrap',
        overflow: 'auto',
        background: TR.bg,
      }}
    >
      {/* Connected count */}
      <span style={{ whiteSpace: 'nowrap' }}>
        <span style={{ color: TR.textDim }}>Connected </span>
        <span
          className="tr-num"
          style={{
            color: TR.text,
            fontWeight: 500,
            fontFamily: FONT_MONO,
            display: 'inline',
          }}
        >
          {connected.toLocaleString()}
        </span>
      </span>

      {/* Divider */}
      <span style={{ color: TR.border }}>│</span>

      {/* Tokens 24h */}
      <span style={{ whiteSpace: 'nowrap' }}>
        <span style={{ color: TR.textDim }}>Tokens 24h </span>
        <span
          className="tr-num"
          style={{
            color: TR.text,
            fontWeight: 500,
            fontFamily: FONT_MONO,
            display: 'inline',
          }}
        >
          {formatTokens(tokens24h)}
        </span>
      </span>

      {/* Divider */}
      <span style={{ color: TR.border }}>│</span>

      {/* Cost 24h */}
      <span style={{ whiteSpace: 'nowrap' }}>
        <span style={{ color: TR.textDim }}>Cost 24h </span>
        <span
          className="tr-num"
          style={{
            color: TR.text,
            fontWeight: 500,
            fontFamily: FONT_MONO,
            display: 'inline',
          }}
        >
          {formatUSD(cost24h)}
        </span>
      </span>

      {/* Divider */}
      <span style={{ color: TR.border }}>│</span>

      {/* Records today */}
      <span style={{ whiteSpace: 'nowrap' }}>
        <span style={{ color: TR.textDim }}>Records today </span>
        <span
          className="tr-num"
          style={{
            color: TR.text,
            fontWeight: 500,
            fontFamily: FONT_MONO,
            display: 'inline',
          }}
        >
          {recordsToday}
        </span>
      </span>

      {/* Right-aligned: Updated time */}
      <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
        <LiveDot status="live" label="Updated 4 min ago" />
      </span>
    </div>
  );
}
