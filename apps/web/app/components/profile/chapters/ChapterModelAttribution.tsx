'use client';

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { TR, FONT_MONO } from '@/lib/design-tokens';
import { getDistinctModelColor, PROVIDER_LABEL } from '@/lib/nivo-theme';
import { Card, RuleSectionHeader } from '../shared/StatFooter';
import { formatLoc, formatTokens, formatUsd } from '../charts/utils';

interface ModelCodeBreakdownItem {
  model: string;
  source: 'claude' | 'codex' | 'opencode';
  tokens_total: number;
  cost_usd_total: number;
  ai_coded_loc: number;
  shipped_ai_coded_loc: number;
}

interface ChapterModelAttributionProps {
  modelCodeBreakdown: ModelCodeBreakdownItem[];
}

type SortKey = 'model' | 'tokens' | 'cost' | 'share' | 'produced' | 'shipped' | 'efficiency';
const MAX_VISIBLE_ROWS = 6;

function formatShare(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  if (value < 1) return `${value.toFixed(1)}%`;

  return `${Math.round(value)}%`;
}

function formatUsdPerKLoc(cost: number, loc: number): string {
  if (loc <= 0) return '—';

  return formatUsd((cost / loc) * 1000);
}

function providerLabel(source: ModelCodeBreakdownItem['source']): string {
  return PROVIDER_LABEL[source] ?? source;
}

function sortValue(row: ModelCodeBreakdownItem & { token_share: number; efficiency_per_1k: number | null }, key: SortKey): number | string {
  if (key === 'model') return row.model;
  if (key === 'tokens') return row.tokens_total;
  if (key === 'cost') return row.cost_usd_total;
  if (key === 'share') return row.token_share;
  if (key === 'produced') return row.ai_coded_loc;
  if (key === 'shipped') return row.shipped_ai_coded_loc;
  return row.efficiency_per_1k ?? -1;
}

function BarCell({
  color,
  max,
  value,
  children,
}: {
  children: ReactNode;
  color: string;
  max: number;
  value: number;
}) {
  const width = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;

  return (
    <div style={{ alignItems: 'center', display: 'grid', gap: 12, gridTemplateColumns: 'minmax(120px, 1fr) minmax(76px, auto)' }}>
      <div style={{ background: TR.bgRow, borderRadius: 999, height: 7, overflow: 'hidden' }}>
        <div style={{ background: color, borderRadius: 999, height: '100%', opacity: 0.9, width: `${width}%` }} />
      </div>
      <span>{children}</span>
    </div>
  );
}

export function ChapterModelAttribution({ modelCodeBreakdown }: ChapterModelAttributionProps) {
  const [sortKey, setSortKey] = useState<SortKey>('cost');
  const rowsBase = modelCodeBreakdown
    .filter((row) => row.tokens_total > 0 || row.cost_usd_total > 0 || row.ai_coded_loc > 0 || row.shipped_ai_coded_loc > 0);
  const totalTokens = rowsBase.reduce((sum, row) => sum + row.tokens_total, 0);
  const rows = useMemo(() => {
    const enriched = rowsBase.map((row) => ({
      ...row,
      efficiency_per_1k: row.shipped_ai_coded_loc > 0 ? (row.cost_usd_total / row.shipped_ai_coded_loc) * 1000 : null,
      token_share: totalTokens > 0 ? (row.tokens_total / totalTokens) * 100 : 0,
    }));

    return enriched.sort((left, right) => {
      const leftValue = sortValue(left, sortKey);
      const rightValue = sortValue(right, sortKey);

      if (typeof leftValue === 'string' || typeof rightValue === 'string') {
        return String(leftValue).localeCompare(String(rightValue));
      }

      return rightValue - leftValue;
    });
  }, [rowsBase, sortKey, totalTokens]);
  const visibleRows = rows.slice(0, MAX_VISIBLE_ROWS);
  const maxCost = Math.max(0, ...visibleRows.map((row) => row.cost_usd_total));
  const maxProduced = Math.max(0, ...visibleRows.map((row) => row.ai_coded_loc));
  const maxShipped = Math.max(0, ...visibleRows.map((row) => row.shipped_ai_coded_loc));

  const headers: Array<{ align?: 'left' | 'right'; key: SortKey; label: string }> = [
    { align: 'left', key: 'model', label: 'Model' },
    { key: 'tokens', label: 'Tokens' },
    { key: 'cost', label: 'Cost' },
    { key: 'share', label: 'Share' },
    { key: 'produced', label: 'Produced' },
    { key: 'shipped', label: 'Shipped' },
    { key: 'efficiency', label: '$ / 1K' },
  ];

  return (
    <section>
      <RuleSectionHeader
        number="03"
        title="Per-model attribution - cost & shipped code"
        meta={`top ${Math.min(MAX_VISIBLE_ROWS, rows.length)} of ${rows.length} models · click a header to sort`}
      />
      <Card>
        {rows.length === 0 ? (
          <div style={{ color: TR.textMid, fontFamily: FONT_MONO, fontSize: 12, lineHeight: 1.7, padding: 24 }}>
            No direct commit-SHA attribution is available yet. Model rows appear after local Claude, Codex, or OpenCode logs contain git commit SHAs that resolve in selected repos.
          </div>
        ) : (
          <div style={{ overflowX: 'auto', padding: '18px 22px 20px' }}>
            <table style={{ borderCollapse: 'collapse', minWidth: 1040, width: '100%' }}>
              <thead>
                <tr>
                  {headers.map((header) => (
                    <th
                      key={header.key}
                      style={{
                        borderBottom: `1px solid ${TR.border}`,
                        color: sortKey === header.key ? TR.accent : TR.textMid,
                        cursor: 'pointer',
                        fontFamily: FONT_MONO,
                        fontSize: 10,
                        fontWeight: 500,
                        letterSpacing: '0.1em',
                        padding: '0 12px 12px',
                        textAlign: header.align ?? 'right',
                        textTransform: 'uppercase',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => setSortKey(header.key)}
                    >
                      {header.label}{sortKey === header.key ? ' ↓' : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const color = getDistinctModelColor(row.model);

                  return (
                    <tr key={`${row.source}:${row.model}`}>
                      <td style={{ borderBottom: `1px solid ${TR.border}`, padding: '13px 12px' }}>
                        <div style={{ alignItems: 'center', display: 'flex', gap: 10, minWidth: 0 }}>
                          <span style={{ background: color, borderRadius: 3, flexShrink: 0, height: 12, width: 12 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: TR.text, fontFamily: FONT_MONO, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {row.model}
                            </div>
                            <div style={{ color: TR.textDim, fontFamily: FONT_MONO, fontSize: 10, marginTop: 4, textTransform: 'uppercase' }}>
                              {providerLabel(row.source)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={{ borderBottom: `1px solid ${TR.border}`, color: TR.textMid, fontFamily: FONT_MONO, fontSize: 12, padding: '13px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {formatTokens(row.tokens_total)}
                      </td>
                      <td style={{ borderBottom: `1px solid ${TR.border}`, color: TR.text, fontFamily: FONT_MONO, fontSize: 12, padding: '13px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <BarCell color={color} max={maxCost} value={row.cost_usd_total}>
                          {formatUsd(row.cost_usd_total)}
                        </BarCell>
                      </td>
                      <td style={{ borderBottom: `1px solid ${TR.border}`, color: TR.textDim, fontFamily: FONT_MONO, fontSize: 12, padding: '13px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {formatShare(row.token_share)}
                      </td>
                      <td style={{ borderBottom: `1px solid ${TR.border}`, color: TR.text, fontFamily: FONT_MONO, fontSize: 12, padding: '13px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <BarCell color={color} max={maxProduced} value={row.ai_coded_loc}>
                          {formatLoc(row.ai_coded_loc)}
                        </BarCell>
                      </td>
                      <td style={{ borderBottom: `1px solid ${TR.border}`, color: row.shipped_ai_coded_loc > 0 ? TR.accent : TR.textDim, fontFamily: FONT_MONO, fontSize: 12, fontWeight: row.shipped_ai_coded_loc > 0 ? 600 : 400, padding: '13px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <BarCell color={row.shipped_ai_coded_loc > 0 ? TR.accent : TR.textDim} max={maxShipped} value={row.shipped_ai_coded_loc}>
                          {formatLoc(row.shipped_ai_coded_loc)}
                        </BarCell>
                      </td>
                      <td style={{ borderBottom: `1px solid ${TR.border}`, color: row.shipped_ai_coded_loc > 0 ? TR.text : TR.textDim, fontFamily: FONT_MONO, fontSize: 12, padding: '13px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {formatUsdPerKLoc(row.cost_usd_total, row.shipped_ai_coded_loc)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
