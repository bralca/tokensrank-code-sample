'use client';

import { TR, LAYOUT, SPACING, FONT_MONO } from '@/lib/design-tokens';
import { Delta } from '@/components/primitives/Delta';

interface HeadlineProps {
  rank: number;
  rankDelta?: number;
  totalRanked: number;
  percentile: string;
  totalCost: number;
  totalTokens: number;
}

function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(Math.round(n));
}

export function Headline({
  rank,
  rankDelta = 0,
  totalRanked,
  percentile,
  totalCost,
  totalTokens,
}: HeadlineProps) {
  return (
    <section
      style={{
        padding: `${SPACING.xl}px 0 ${SPACING['2xl']}px`,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 0,
          border: `1px solid ${TR.border}`,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        {/* Rank Card */}
        <div
          style={{
            padding: '36px 36px 32px',
            borderRight: `1px solid ${TR.border}`,
            background: TR.bg,
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: TR.textMid,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontWeight: 500,
              marginBottom: 12,
            }}
          >
            global rank
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 14,
            }}
          >
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 96,
                fontWeight: 600,
                letterSpacing: '-0.04em',
                lineHeight: 0.95,
                color: TR.text,
              }}
            >
              #{rank}
            </span>

            {rankDelta !== undefined && (
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 16,
                  color: rankDelta > 0 ? TR.up : rankDelta < 0 ? TR.down : TR.flat,
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {rankDelta > 0 ? '↑' : rankDelta < 0 ? '↓' : '—'}
                {Math.abs(rankDelta)}
                <span style={{ color: TR.textDim, marginLeft: 6 }}>this month</span>
              </span>
            )}
          </div>

          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12.5,
              color: TR.textDim,
              marginTop: 10,
            }}
          >
            of {totalRanked.toLocaleString()} builders · {percentile}
          </div>
        </div>

        {/* Cost Card */}
        <div
          style={{
            padding: '36px 36px 32px',
            background: TR.bg,
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: TR.textMid,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontWeight: 500,
              marginBottom: 12,
            }}
          >
            total cost
          </div>

          <div
            style={{
              marginTop: 12,
            }}
          >
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 96,
                fontWeight: 600,
                letterSpacing: '-0.04em',
                lineHeight: 0.95,
                color: TR.text,
              }}
            >
              ${totalCost.toLocaleString()}
            </span>
          </div>

          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12.5,
              color: TR.textDim,
              marginTop: 10,
            }}
          >
            {fmtTok(totalTokens)} tokens · all-time
          </div>
        </div>
      </div>
    </section>
  );
}
