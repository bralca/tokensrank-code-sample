'use client';

import Link from 'next/link';
import { TR, LAYOUT, SPACING } from '@/lib/design-tokens';
import type { LeaderboardPeriod, LeaderboardScope } from '../../../../../packages/shared/src/schemas/leaderboard';

interface LeaderboardHeaderProps {
  period?: LeaderboardPeriod;
  scope?: LeaderboardScope;
  connectedBuilders?: number;
}

const periodOptions = [
  { id: 'all', label: 'All-time' },
  { id: '30d', label: '30D' },
  { id: '7d', label: '7D' },
  { id: '24h', label: '24H' },
] as const;

const scopeOptions = [
  { id: 'all', label: 'All' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
] as const;

function buildHref(period: string, scope: string): string {
  const params = new URLSearchParams({ period, scope });
  return `/?${params.toString()}`;
}

function TabGroup({
  label,
  options,
  activeValue,
  onSelect,
}: {
  label?: string;
  options: readonly typeof periodOptions[number][];
  activeValue: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: 4,
        background: TR.bgSoft,
        borderRadius: '999px',
        border: `1px solid ${TR.border}`,
      }}
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onSelect(opt.id)}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            fontWeight: 500,
            color: activeValue === opt.id ? TR.text : TR.textMid,
            cursor: 'pointer',
            borderRadius: '999px',
            background: activeValue === opt.id ? TR.borderHi : 'transparent',
            border: 'none',
            transition: 'all 0.2s ease',
            fontFamily: 'inherit',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function LeaderboardHeader({
  period = 'all',
  scope = 'all',
  connectedBuilders = 41920,
}: LeaderboardHeaderProps) {
  return (
    <section
      style={{
        padding: `${SPACING['2xl']}px ${LAYOUT.contentPadding}px ${SPACING['3xl']}px`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        gap: 24,
      }}
    >
      {/* Left: H1 + Subheading */}
      <div>
        <h1
          style={{
            fontSize: 32,
            fontWeight: 600,
            margin: 0,
            letterSpacing: '-0.025em',
            color: TR.text,
          }}
        >
          Top builders by token usage
        </h1>
        <p
          style={{
            fontSize: 14,
            color: TR.textMid,
            margin: '6px 0 0',
            lineHeight: 1.5,
          }}
        >
          Ranked across {connectedBuilders.toLocaleString()} connected machines · Season Q2 2026
        </p>
      </div>

      {/* Right: Filter tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* Time period filter */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: 4,
            background: TR.bgSoft,
            borderRadius: '999px',
            border: `1px solid ${TR.border}`,
          }}
        >
          {periodOptions.map((opt) => (
            <Link
              key={opt.id}
              href={buildHref(opt.id, scope)}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                fontWeight: 500,
                color: period === opt.id ? TR.text : TR.textMid,
                cursor: 'pointer',
                borderRadius: '999px',
                background: period === opt.id ? TR.borderHi : 'transparent',
                border: 'none',
                transition: 'all 0.2s ease',
                fontFamily: 'inherit',
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {opt.label}
            </Link>
          ))}
        </div>

        {/* Model/Scope filter */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: 4,
            background: TR.bgSoft,
            borderRadius: '999px',
            border: `1px solid ${TR.border}`,
          }}
        >
          {scopeOptions.map((opt) => (
            <Link
              key={opt.id}
              href={buildHref(period, opt.id)}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 500,
                color: scope === opt.id ? TR.text : TR.textMid,
                cursor: 'pointer',
                borderRadius: '999px',
                background: scope === opt.id ? TR.borderHi : 'transparent',
                border: 'none',
                transition: 'all 0.2s ease',
                fontFamily: 'inherit',
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {opt.label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
