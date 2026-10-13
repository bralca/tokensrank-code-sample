'use client';

import { useMemo } from 'react';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { modelProvider, PROVIDER_COLOR, PROVIDER_LABEL } from '@/lib/nivo-theme';
import { formatTokens } from './utils';

type Provider = 'claude' | 'codex' | 'opencode' | 'other';

interface SplitBarProps {
  models: Array<{ model: string; tokens_total: number }>;
}

/** Single stacked bar splitting total tokens by provider (Claude vs Codex vs Other),
 * with a legend showing each share. */
export function SplitBar({ models }: SplitBarProps) {
  const segments = useMemo(() => {
    const totals: Record<Provider, number> = { claude: 0, codex: 0, opencode: 0, other: 0 };
    for (const m of models) totals[modelProvider(m.model)] += m.tokens_total || 0;
    const grand = totals.claude + totals.codex + totals.opencode + totals.other;
    return (['claude', 'codex', 'opencode', 'other'] as Provider[])
      .map((p) => ({
        provider: p,
        tokens: totals[p],
        pct: grand > 0 ? (totals[p] / grand) * 100 : 0,
        color: PROVIDER_COLOR[p],
        label: PROVIDER_LABEL[p],
      }))
      .filter((s) => s.tokens > 0);
  }, [models]);

  if (segments.length === 0) return null;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          height: 30,
          borderRadius: 6,
          overflow: 'hidden',
          border: `1px solid ${TR.border}`,
        }}
      >
        {segments.map((s) => (
          <div
            key={s.provider}
            title={`${s.label}: ${formatTokens(s.tokens)} tokens (${s.pct.toFixed(1)}%)`}
            style={{ width: `${s.pct}%`, background: s.color, cursor: 'default' }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginTop: 14 }}>
        {segments.map((s) => (
          <div key={s.provider} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color }} />
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: TR.textMid }}>{s.label}</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: TR.text, fontWeight: 600 }}>
              {s.pct.toFixed(1)}%
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: TR.textDim }}>
              {formatTokens(s.tokens)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
