import type { UsageEvidence, UsageRecap } from '@tokensrank/shared';

type Row = { date: string; source: string; model: string; total_tokens: number; output_tokens: number };
const DAY_MS = 86_400_000;

/** Compare equal UTC date windows, excluding the unfinished current day. Gaps mean no records, not no work. */
export function buildUsageRecap(rows: Row[], evidence: UsageEvidence, nowMs = Date.now()): UsageRecap {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  const date = (offset: number) => new Date(midnight + offset * DAY_MS).toISOString().slice(0, 10);
  const valid = rows.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date <= today);
  const period = (offset: number): UsageRecap['current'] => {
    const dates = Array.from({ length: 7 }, (_, i) => date(offset + i));
    const start = date(offset), end = date(offset + 6);
    const selected = valid.filter(r => r.date >= start && r.date <= end);
    const days = dates.map(d => ({ date: d, tokens: selected.filter(r => r.date === d).reduce((n, r) => n + r.total_tokens, 0) }));
    return { start, end, days,
      tokens: days.reduce((n, d) => n + d.tokens, 0),
      output_tokens: selected.reduce((n, r) => n + r.output_tokens, 0),
      recorded_days: days.filter(d => d.tokens > 0).length };
  };
  const current = period(-7), previous = period(-14);
  const usedSources = [...new Set(valid.filter(r => r.total_tokens > 0).map(r => r.source))];
  const sources = usedSources.map(source => evidence.sources.find(s => s.source === source));
  const reads = sources.map(s => s?.read_at ?? null);
  const readAt = reads.length && reads.every(Boolean) ? reads.reduce<string | null>((min, s) => !min || s! < min ? s : min, null) : null;
  const first = valid.filter(r => r.total_tokens > 0).map(r => r.date).sort()[0];
  const comparison: UsageRecap['comparison'] = !first ? 'no_data'
    : sources.some(s => s?.daily_basis !== 'event_dates') ? 'legacy_dates'
    : !readAt || Date.parse(readAt) < midnight ? 'stale'
    : first > previous.start ? 'short_history' : 'ready';
  const comparable = comparison === 'ready';
  const totals = (start: string, end: string) => {
    const map = new Map<string, number>();
    for (const r of valid) if (r.date >= start && r.date <= end && r.total_tokens > 0) {
      map.set(r.model, (map.get(r.model) ?? 0) + r.total_tokens);
    }
    return map;
  };
  const priorModels = totals(previous.start, previous.end);
  const currentModels = totals(current.start, current.end);
  const modelIds = new Set([...currentModels.keys(), ...(comparable && current.tokens > 0 ? priorModels.keys() : [])]);
  return {
    current, previous, comparison, read_at: readAt,
    change_pct: comparable && previous.tokens > 0 ? (current.tokens / previous.tokens - 1) * 100 : null,
    local_tokens_all_time: valid.reduce((n, r) => n + r.total_tokens, 0),
    models: [...modelIds].sort((a, b) => (currentModels.get(b) ?? 0) - (currentModels.get(a) ?? 0) || (priorModels.get(b) ?? 0) - (priorModels.get(a) ?? 0) || a.localeCompare(b)).map(model => {
      const tokens = currentModels.get(model) ?? 0;
      const share = current.tokens > 0 ? tokens / current.tokens : 0;
      const previousShare = comparable && previous.tokens > 0 ? (priorModels.get(model) ?? 0) / previous.tokens : null;
      return { model, tokens, share, previous_share: previousShare, change_points: previousShare === null ? null : (share - previousShare) * 100 };
    }),
  };
}
