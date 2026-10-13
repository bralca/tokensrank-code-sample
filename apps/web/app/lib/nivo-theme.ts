import { TR, FONT_MONO } from './design-tokens';

/**
 * Shared Nivo theme so every chart matches the TokensRank dark / mono / lime look,
 * with readable axes, dotted gridlines, and a styled hover tooltip.
 */
export const nivoTheme = {
  background: 'transparent',
  text: { fontFamily: FONT_MONO, fontSize: 11, fill: TR.textMid },
  axis: {
    domain: { line: { stroke: TR.border, strokeWidth: 1 } },
    ticks: {
      line: { stroke: TR.border, strokeWidth: 1 },
      text: { fill: TR.textDim, fontSize: 10, fontFamily: FONT_MONO },
    },
    legend: { text: { fill: TR.textMid, fontSize: 11, fontFamily: FONT_MONO, letterSpacing: '0.04em' } },
  },
  grid: { line: { stroke: TR.border, strokeDasharray: '2 4', strokeOpacity: 0.45 } },
  legends: { text: { fill: TR.textMid, fontFamily: FONT_MONO, fontSize: 11 } },
  labels: { text: { fill: TR.text, fontFamily: FONT_MONO } },
  tooltip: {
    container: {
      background: TR.bgSoft,
      color: TR.text,
      fontSize: 12,
      fontFamily: FONT_MONO,
      border: `1px solid ${TR.borderHi}`,
      borderRadius: 8,
      padding: '8px 12px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    },
  },
  crosshair: { line: { stroke: TR.accent, strokeWidth: 1, strokeOpacity: 0.45, strokeDasharray: '3 3' } },
  annotations: { text: { fill: TR.text, fontFamily: FONT_MONO } },
} as const;

/** Sequential dark→lime ramp for intensity heatmaps (tokens/day, shipped LOC/day). */
export const LIME_RAMP = ['#11160B', '#1F2A1A', '#3F5A1F', '#6B8F2A', '#9FCB3A', '#B6FF3C'];

/** Categorical palette for per-model coloring (Codex/gpt → greens, Claude → ambers, other → blues). */
const CODEX_HUES = ['#B6FF3C', '#9FCB3A', '#6B8F2A', '#4F7A1E', '#86C7A0', '#3F5A1F'];
const CLAUDE_HUES = ['#F0A93C', '#E8C15A', '#C98B2E', '#F2D08A', '#B8742A'];
const OPENCODE_HUES = ['#2DD4BF', '#4CC9F0', '#38BDF8', '#22C55E'];
const OTHER_HUES = ['#6AA9F0', '#9B8CF0', '#5E6673'];
const MODEL_DISTINCT_HUES = [
  '#B6FF3C',
  '#F0A93C',
  '#6AA9F0',
  '#D66BFF',
  '#2DD4BF',
  '#FF6B6B',
  '#FFD166',
  '#A78BFA',
  '#4CC9F0',
  '#F9844A',
  '#90BE6D',
  '#F472B6',
  '#38BDF8',
  '#C084FC',
  '#FB7185',
  '#94A3B8',
];

function hashIndex(value: string, length: number): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return length > 0 ? h % length : 0;
}

/** Provider family for a model (for Claude-vs-Codex grouping). */
export function modelProvider(model: string): 'claude' | 'codex' | 'opencode' | 'other' {
  const m = (model || '').toLowerCase();
  if (m.startsWith('claude')) return 'claude';
  if (m.startsWith('gpt') || m.includes('codex') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'codex';
  if (m.includes('opencode') || m.startsWith('deepseek') || m.startsWith('qwen')) return 'opencode';
  return 'other';
}

/** Deterministic color for a model name, grouped by provider family so the
 * dominance strip reads as "green = Codex days, amber = Claude days". */
export function getModelColor(model: string): string {
  const provider = modelProvider(model);
  const m = (model || '').toLowerCase();
  if (provider === 'claude') return CLAUDE_HUES[hashIndex(m, CLAUDE_HUES.length)]!;
  if (provider === 'codex') return CODEX_HUES[hashIndex(m, CODEX_HUES.length)]!;
  if (provider === 'opencode') return OPENCODE_HUES[hashIndex(m, OPENCODE_HUES.length)]!;
  return OTHER_HUES[hashIndex(m, OTHER_HUES.length)]!;
}

/** Distinct model color for crowded model-comparison charts where provider-group
 * hue scales become hard to distinguish. */
export function getDistinctModelColor(model: string): string {
  return MODEL_DISTINCT_HUES[hashIndex((model || '').toLowerCase(), MODEL_DISTINCT_HUES.length)]!;
}

/** Static provider logo path (committed under web/public/model-logos), or null. */
export function providerLogo(model: string): string | null {
  const provider = modelProvider(model);
  if (provider === 'claude') return '/model-logos/anthropic.svg';
  if (provider === 'codex') return '/model-logos/openai.svg';
  return null;
}

/** Provider display color (for the Claude-vs-Codex split bar + legend). */
export const PROVIDER_COLOR: Record<'claude' | 'codex' | 'opencode' | 'other', string> = {
  claude: '#F0A93C',
  codex: '#B6FF3C',
  opencode: '#2DD4BF',
  other: '#6AA9F0',
};

export const PROVIDER_LABEL: Record<'claude' | 'codex' | 'opencode' | 'other', string> = {
  claude: 'Claude',
  codex: 'Codex / GPT',
  opencode: 'OpenCode',
  other: 'Other',
};
