# Profile Page Design-to-Spec Mapping (L0-L4)

**Last Updated:** 2026-05-01  
**Design Chapters:** L0 (Presence) → L1 (Volume) → L2 (Cadence) → L3 (Breadth) → L4 (Mastery)  
**Window:** 90-day rolling window (fixed, not user-selectable)

---

## Executive Summary

This document maps 5 design mockup chapters (L0-L4) to specification requirements. Each chapter represents a progressive narrative layer revealing deeper insights about a user's AI usage patterns. All visualizations operate on pre-computed hourly metrics (no on-demand computation).

---

## L0: Presence — "Showing Up"

### Visual Narrative
- **Headline:** Bold rank/cost statement + "Showing up" subtitle
- **Hero chart:** 90-day daily token sparkline (bar chart, green bars)
- **Purpose:** First impression—how active is this user?

### Spec Requirements Mapping

| UI Element | Spec Field | API Source | Type | Notes |
|------------|-----------|-----------|------|-------|
| Rank number (e.g., "#42") | `headline.rank` | `profile_metrics_cache.rank` (7d window) | integer | Position in leaderboard for active period |
| Rank delta label (e.g., "↑5") | `headline.rank_delta_30d` | `profile_metrics_cache.rank_delta_30d` | integer | Calculated from 30d → now comparison |
| Total tokens (e.g., "2.4M") | `headline.tokens_total` | `profile_metrics_cache.tokens_total` (7d) | number | Formatted with `formatTokens()` |
| Cost USD (e.g., "$0.02") | `headline.cost_usd_total` | `profile_metrics_cache.cost_usd_total` (7d) | number | Formatted with `formatCost()` |
| Percentile label (e.g., "Top 12%") | `headline.percentile` | `profile_metrics_cache.percentile` | string | Pre-formatted in API response |
| Daily token bars (90 days) | N/A (computed) | Session data from last 90 days | chart data | **NOT pre-computed**; must be computed in endpoint |
| Bar color (green) | Design token `TR.accent` | N/A | CSS | `#B6FF3C` acid lime |

### Pre-Computed Fields Needed
From `profile_metrics_cache` (7d window):
- `rank`
- `percentile`
- `tokens_total`
- `cost_usd_total`
- `total_ranked`

### Calculated/Derived Fields
- `rank_delta_30d`: Computed by comparing 30d rank snapshot to current 7d rank (⚠️ not pre-computed in current implementation)
- **Daily sparkline data:** Requires aggregating individual sessions into daily buckets (0-90 days). This is a chart rendering computation, not a cached metric.

### Chart Configuration

**Chart Type:** Observable Plot bar chart  
**Data Source:** Sessions filtered to last 90 days, grouped by date, summed by token count  
**Dimensions:**
- Width: Full section width minus padding (responsive)
- Height: 64px (sparkline style)
- Bar spacing: 1px
- Bar color: `TR.accent` (#B6FF3C)
- Background: `TR.bg` (#0B0E11)

**Observable Plot Config:**
```typescript
Plot.plot({
  marks: [
    Plot.barY(dailyData, {
      x: 'date',
      y: 'tokens',
      fill: TR.accent,
    })
  ],
  x: { type: 'temporal' },
  y: { domain: [0, max] },
  // Remove axes, grid, labels for sparkline look
  axis: null,
  grid: false,
})
```

### Empty-State Conditions
- **no_sessions:** If 0 sessions in 90d window, show placeholder message "No activity in the last 90 days"
- **need_7d:** (Not applicable; L0 is presence-oriented, always show if profile exists)

### Design Token Usage
- **Typography:**
  - Rank/cost headline: `TYPOGRAPHY.h2` (26px, semibold)
  - "Showing up" subtitle: `TYPOGRAPHY.caption` (11px)
- **Colors:**
  - Rank: `TR.text` (#EAECEF)
  - Cost: `TR.accent` (#B6FF3C)
  - Bar: `TR.accent` (#B6FF3C)
- **Spacing:**
  - Section padding: `LAYOUT.contentPadding` (28px)
  - Chart height: 64px
  - Margin after headline: `SPACING['3xl']` (28px)

### Responsive Behavior
- Mobile (<640px): Stack headline vertically, reduce bar width
- Tablet (640-1024px): Side-by-side headline + bars
- Desktop (>1024px): Full width, bars scale smoothly

### Deviations from Original Spec
- **Daily sparkline not pre-computed:** Spec assumes `daily_tokens` array in cache; current implementation only stores `hourly_pattern` and `daily_pattern` (session counts, not token sums). Daily token bucketing must happen in the API endpoint or frontend.
- **Rank delta missing:** `rank_delta_30d` is not calculated in `metrics-computation.ts`. Requires snapshot comparison logic.

---

## L1: Volume — Cumulative 90-Day Tokens

### Visual Narrative
- **Chart:** Cumulative area chart of tokens over 90 days (y-axis: cumulative tokens, x-axis: date)
- **Peak marker:** Annotation showing largest single-day token count + date
- **Captions row:** 4-cell strip with session/time/duration/longest/cost metrics

### Spec Requirements Mapping

| UI Element | Spec Field | API Source | Type | Notes |
|------------|-----------|-----------|------|-------|
| Cumulative area chart | Computed from daily tokens | Session data last 90d | chart data | Sum daily tokens cumulatively |
| Peak day marker | `session_stats.largest_by_tokens` | `profile_sessions_cache.tokens_total` (max) | object | Includes date |
| Total sessions | `at_glance.sessions_count` | `profile_metrics_cache.sessions_count` | integer | Format: "1,234 sessions" |
| Total time in sessions | `session_stats.total_time_in_sessions.value` | Computed from `first_event_at` + `last_event_at` | string | Format: "123h 45m" |
| Session duration (median) | `session_stats.median_session.value` | Computed from all sessions | string | Format: "38m" |
| Longest session | `session_stats.longest_session` | Computed from session times | object | Includes duration + date |
| Total cost | `at_glance.cost_usd_total` | `profile_metrics_cache.cost_usd_total` | number | Format: "$0.24" |

### Pre-Computed Fields Needed
From `profile_metrics_cache` (7d window):
- `sessions_count`
- `cost_usd_total`

From `profile_sessions_cache` (top 10):
- `started_at`, `ended_at` (for median/total time calculation)
- `tokens_total` (for finding peak day)

### Calculated/Derived Fields
- **Cumulative tokens by day:** Requires aggregating daily tokens into running total
- **Longest session duration:** `max(ended_at - started_at)` across all sessions
- **Median session duration:** Percentile calculation across all sessions
- **Total time in sessions:** Sum of all `(ended_at - started_at)` durations
- **Peak day:** `argmax(daily_tokens)` + corresponding date

### Chart Configuration

**Chart Type:** Observable Plot area chart  
**Data Source:** Sessions last 90 days, grouped by date, summed tokens, then cumsum applied  
**Dimensions:**
- Width: Full section width minus padding
- Height: 200px
- X-axis: Date labels (every 14 days)
- Y-axis: Cumulative token count
- Area fill: `TR.accent` with 0.3 opacity
- Line stroke: `TR.accent` full opacity

**Observable Plot Config:**
```typescript
Plot.plot({
  marks: [
    Plot.area(cumulativeData, {
      x: 'date',
      y: 'cumTokens',
      fill: TR.accent,
      opacity: 0.3,
      stroke: TR.accent,
      strokeWidth: 2,
    }),
    // Peak marker
    Plot.dot([peakDay], {
      x: 'date',
      y: 'cumTokens',
      r: 4,
      fill: TR.accent,
    })
  ],
  x: { type: 'temporal', label: 'Date' },
  y: { label: 'Cumulative Tokens' },
  width: containerWidth,
  height: 200,
})
```

### Empty-State Conditions
- **no_sessions:** Show message "No sessions in the last 90 days"
- **insufficient_data:** Chart still renders with available data

### Design Token Usage
- **Typography:**
  - Section title: `TYPOGRAPHY.label` (10.5px, uppercase, mono)
  - Stat cell labels: `TYPOGRAPHY.caption` (11px)
- **Colors:**
  - Area: `TR.accent` with opacity 0.3
  - Line: `TR.accent`
  - Peak marker: `TR.accent`
- **Spacing:**
  - Chart height: 200px
  - Cell padding: `SPACING['lg']` (16px) per cell
  - Stat cell grid: 4 columns

### Responsive Behavior
- Mobile: Stack captions vertically (2x2 grid)
- Tablet: 4-column grid maintained
- Desktop: Full 4-column grid

### Deviations from Original Spec
- **Peak marker requires scan:** Peak day not pre-computed; must find `max(daily_tokens)` in frontend or API
- **Session duration metrics not cached:** Median session and total time must be computed in endpoint from `profile_sessions_cache` timestamps

---

## L2: Cadence — 90-Day Daily-Session Heatmap + Patterns

### Visual Narrative
- **90-day heatmap:** Daily bar chart where bar height = session count, colored with streak shading
  - Green for active days (1+ sessions)
  - Gray for inactive days (0 sessions)
- **Current/longest streaks:** Highlight consecutive active days
- **Hour-of-day + day-of-week histograms:** Distribution charts
- **Timezone/busiest metrics:** 2-cell strip (busiest hour, busiest day)

### Spec Requirements Mapping

| UI Element | Spec Field | API Source | Type | Notes |
|------------|-----------|-----------|------|-------|
| 90-day daily session bars | Computed from sessions | Session count per day | chart data | Height = session count, color = streak status |
| Streak highlighting (green) | `cadence.current_streak` + logic | `profile_metrics_cache.current_streak` | integer | Day range: today back N days |
| Busiest hour label | `cadence.busiest_hour` | Pre-formatted in API | string | Format: "14:00" or "2 PM" |
| Busiest day label | `cadence.busiest_day` | Pre-formatted in API | string | Format: "Thursday" |
| Hour histogram (24 bars) | `cadence.hourly` | `profile_cadence_cache.hourly_pattern` | array[24] | Session count per UTC hour |
| Day histogram (7 bars) | `cadence.daily` | `profile_cadence_cache.daily_pattern` | array[7] | Session count per weekday |
| Current streak (e.g., "5 days") | `cadence.current_streak` | `profile_metrics_cache.current_streak` | integer | Display: "X days" |
| Longest streak (e.g., "12 days") | `cadence.longest_streak` | `profile_metrics_cache.longest_streak` | integer | Display: "X days" |
| Sessions after midnight count | `cadence.after_midnight.count` | `profile_metrics_cache.after_midnight_count` | integer | Sessions starting 00:00-05:59 UTC |
| After midnight percentage | `cadence.after_midnight.pct` | `profile_metrics_cache.after_midnight_pct` | number (0-1) | Display as "%": `(pct * 100).toFixed(0)` |
| Weekend share percentage | `cadence.weekend_share` | `profile_metrics_cache.weekend_share` | number (0-1) | Display as "%": `(pct * 100).toFixed(0)` |

### Pre-Computed Fields Needed
From `profile_metrics_cache` (7d window):
- `current_streak`
- `longest_streak`
- `after_midnight_count`
- `after_midnight_pct`
- `weekend_share`

From `profile_cadence_cache`:
- `hourly_pattern` (array[24])
- `daily_pattern` (array[7])

### Calculated/Derived Fields
- **Daily session bars (90 days):** Group sessions by date, count per date (not pre-computed; must compute in endpoint)
- **Busiest hour:** `argmax(hourly_pattern)` + format as time string
- **Busiest day:** `argmax(daily_pattern)` + format as day name
- **Streak coloring logic:** Mark days in `[today - currentStreak + 1, today]` as green; rest as gray

### Chart Configuration

**Chart 1: 90-Day Heatmap (Daily Session Bars)**

```typescript
Plot.plot({
  marks: [
    Plot.barY(dailySessionData, {
      x: 'date',
      y: 'sessionCount',
      fill: (d) => isInCurrentStreak(d.date) ? TR.accent : TR.textDim,
    })
  ],
  x: { type: 'temporal', label: 'Date' },
  y: { label: 'Sessions' },
  color: { legend: true }, // Green = streak, Gray = no activity
  width: containerWidth,
  height: 120,
})
```

**Chart 2: Hour-of-Day Histogram (24 bars)**

```typescript
Plot.plot({
  marks: [
    Plot.barY(hourlyData, {
      x: 'hour',
      y: 'count',
      fill: (d, i) => i === peakHourIdx ? TR.accent : TR.textMid,
    })
  ],
  x: { domain: [0, 23], label: 'Hour (UTC)' },
  y: { label: 'Sessions' },
  width: 400,
  height: 84,
})
```

**Chart 3: Day-of-Week Histogram (7 bars)**

```typescript
Plot.plot({
  marks: [
    Plot.barY(dailyData, {
      x: 'day',
      y: 'count',
      fill: (d, i) => i === peakDayIdx ? TR.accent : TR.textMid,
    })
  ],
  x: { domain: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], label: 'Day' },
  y: { label: 'Sessions' },
  width: 200,
  height: 84,
})
```

### Empty-State Conditions
- **no_sessions:** Show placeholder "No sessions in the last 90 days"
- **insufficient_data:** Render histograms with zeros

### Design Token Usage
- **Typography:**
  - Section title: `TYPOGRAPHY.label` (10.5px, mono, uppercase)
  - Stat cell label: `TYPOGRAPHY.caption`
  - Metric value: `TYPOGRAPHY.mono` (13.5px)
- **Colors:**
  - Active streak: `TR.accent` (#B6FF3C)
  - Inactive days: `TR.textDim` (#5E6673)
  - Peak bars: `TR.accent`
  - Normal bars: `TR.textMid` (#848E9C)
  - Grid lines: `TR.border` (#1E232B)
- **Spacing:**
  - Heatmap height: 120px
  - Histogram height: 84px each
  - Cell padding: `SPACING['lg']` (16px)
  - Gap between histograms: `SPACING['sm']` (8px)

### Responsive Behavior
- Mobile: Stack all charts vertically; reduce bar width
- Tablet: 2-column layout (heatmap spans full width, histograms side-by-side)
- Desktop: Full layout maintained

### Deviations from Original Spec
- **Daily session counts not pre-computed:** Must aggregate from raw sessions
- **Hour/day labels:** Pre-computed in `hourly_pattern` and `daily_pattern` (counts), but labels must be formatted in frontend
- **Busiest labels computed:** API should pre-format, but if not, compute `argmax` and convert to readable string

---

## L3: Breadth — 90-Day Model Strip + Per-Model Sparklines

### Visual Narrative
- **Model strip:** 90-day calendar where each day shows a single colored cell (dominant model for that day)
  - 13 weeks × 7 days = 91 cells
  - Color per model (palette repeats if >10 models)
- **Distinct model count:** (e.g., "12 different models")
- **First/latest model:** Timestamps and names (e.g., "Claude 3.5 on May 1")
- **Per-model sparklines:** Token count bar chart for each model, with trend indicator (↑↓→)
- **Token/cost breakdown:** List of top N models by token usage

### Spec Requirements Mapping

| UI Element | Spec Field | API Source | Type | Notes |
|------------|-----------|-----------|------|-------|
| 90-day model strip | Computed from sessions | Daily dominant model per day | chart data | Model with most tokens each day |
| Model color palette | Design system | N/A | CSS | ~10 distinct colors, rotate |
| Distinct model count | `models.distinct` | `profile_models_breakdown_cache` (count of rows) | integer | Display: "12 different models" |
| First model name + date | `models.first_model.name` + `models.first_model.date` | API pre-formatted | object | E.g., "Claude 3.5 on Apr 10" |
| Latest model name + date | `models.latest_model.name` + `models.latest_model.date` | API pre-formatted | object | E.g., "Claude 4 on Apr 30" |
| Top model by sessions | `models.top_by_sessions` | API pre-formatted | string | Name of model with most sessions |
| Per-model sparkline (tokens) | Computed from daily totals | `profile_models_breakdown_cache.tokens_total` | chart | Bar chart per model |
| Per-model token count | `models.models[i].tokens` | `profile_models_breakdown_cache.tokens_total` | number | Format: "1.2M tokens" |
| Per-model cost | `models.models[i].cost` | `profile_models_breakdown_cache.cost_usd` | number | Format: "$0.01" |
| Per-model share | `models.models[i].share` | `profile_models_breakdown_cache.pct_of_total` | number (0-1) | Display: "24%" |
| Trend indicator | Computed | Compare daily tokens this period vs previous | symbol | ↑ up, ↓ down, → flat |

### Pre-Computed Fields Needed
From `profile_models_breakdown_cache` (all models, 7d window):
- `tokens_total` per model
- `cost_usd` per model
- `pct_of_total` per model

### Calculated/Derived Fields
- **90-day dominant model strip:** For each day 0-90, find model with highest token count (requires raw session data or daily aggregates)
- **Model colors:** Map model name to color (deterministic hash or predefined palette)
- **Per-model daily tokens:** Aggregate sessions by model by date (sparkline data)
- **Trend indicator:** Compare average tokens first 30d vs last 30d; determine ↑↓→
- **First/latest model dates:** Derived from session min/max timestamps per model

### Chart Configuration

**Chart 1: 90-Day Model Strip (13×7 grid)**

```typescript
// Render as 91 colored squares in a grid
// Each square = one day, color = dominant model
<div style={{
  display: 'grid',
  gridTemplateColumns: 'repeat(7, 1fr)',
  gap: '4px',
}}>
  {dailyModels.map((model, i) => (
    <div
      key={i}
      style={{
        width: '100%',
        paddingBottom: '100%', // Square
        background: getModelColor(model),
        position: 'relative',
      }}
      title={`${date[i]}: ${model}`}
    />
  ))}
</div>
```

**Chart 2: Per-Model Sparkline (Observable Plot)**

```typescript
Plot.plot({
  marks: [
    Plot.barY(modelDailyData, {
      x: 'date',
      y: 'tokens',
      fill: modelColor,
    })
  ],
  x: { type: 'temporal' },
  y: { domain: [0, max] },
  axes: false, // Sparkline style
  width: 120,
  height: 32,
})
```

### Empty-State Conditions
- **need_2_models:** If fewer than 2 distinct models, show message "Use more than one model to see breadth"
- **no_sessions:** Show placeholder

### Design Token Usage
- **Typography:**
  - Section title: `TYPOGRAPHY.label` (10.5px)
  - Model name: `TYPOGRAPHY.bodySm` (12px)
  - Metric label: `TYPOGRAPHY.caption` (11px)
- **Colors:**
  - Model palette: 10 distinct hues (e.g., accent green, blues, reds, purples)
  - Default: `TR.accent` (#B6FF3C) for first model
- **Spacing:**
  - Strip gap: 4px
  - Cell size: responsive (e.g., 14px on mobile, 20px on desktop)
  - Sparkline gap: `SPACING['sm']` (8px) below strip

### Responsive Behavior
- Mobile: Reduce cell size to fit 7 columns in viewport
- Tablet: Standard 7-column grid
- Desktop: Larger cells, full detail

### Deviations from Original Spec
- **Daily dominant model not pre-computed:** Requires runtime calculation to find max-token model per day
- **Per-model trend arrows:** Not in cache; must compute in endpoint or frontend
- **Model color palette:** Not standardized; needs design decision (10-12 distinct colors)

---

## L4: Mastery — 90-Day Peak-Concurrent Calendar + Parallelism Tier Ladder

### Visual Narrative
- **Peak-concurrent calendar:** 13-week grid (91 days) where each cell's fill intensity represents peak concurrent sessions that day
  - Lightest (gray): 1 concurrent session
  - Darkest (bright accent): 5+ concurrent sessions
- **Tier ladder:** 5-step progression (Solo → Pair → Trio → Squad → Swarm)
  - Each tier = range of peak concurrent sessions (1, 2, 3, 4+, 5+)
  - Show count of days at each tier
- **Peak stats:** Max ever, date/time, avg concurrent, sustained-3 duration

### Spec Requirements Mapping

| UI Element | Spec Field | API Source | Type | Notes |
|------------|-----------|-----------|------|-------|
| 90-day peak-concurrent heatmap | Computed from sessions | Daily peak concurrency | chart data | Intensity scale: 0-5 concurrent |
| Peak value (daily) | `parallelism.peak_daily` | `profile_metrics_cache.peak_daily` (array[90]) | array[number] | Max concurrent sessions each day |
| Peak ever (max across period) | `parallelism.peak_ever` | `profile_metrics_cache.peak_ever` | integer | E.g., 7 sessions concurrent |
| Peak ever date/time | `parallelism.peak_ever_date` + `peak_ever_time` | Pre-formatted in API | string | E.g., "Apr 28, 14:32" |
| Tier 1 (Solo): 1 session | `parallelism.buckets[0]` | Computed from peak_daily | object | Days count, percentage |
| Tier 2 (Pair): 2 sessions | `parallelism.buckets[1]` | Computed from peak_daily | object | Days count, percentage |
| Tier 3 (Trio): 3 sessions | `parallelism.buckets[2]` | Computed from peak_daily | object | Days count, percentage |
| Tier 4 (Squad): 4 sessions | `parallelism.buckets[3]` | Computed from peak_daily | object | Days count, percentage |
| Tier 5 (Swarm): 5+ sessions | `parallelism.buckets[4]` | Computed from peak_daily | object | Days count, percentage |
| Avg concurrent | `parallelism.avg_concurrent` | `profile_metrics_cache.avg_concurrent` | number | Display: "2.3 sessions" |
| Days with 3+ parallel | `parallelism.days_parallel_3` | `profile_metrics_cache.days_parallel_3` | integer | Display: "8 days" |
| Longest sustained 3+ seconds | `parallelism.longest_sustained_3` | Pre-formatted from `longest_sustained_3_seconds` | string | Format: "45m 32s" |

### Pre-Computed Fields Needed
From `profile_metrics_cache` (7d window):
- `peak_daily` (array[90], pre-computed or computed in endpoint)
- `peak_ever`
- `peak_ever_date`
- `peak_ever_time`
- `avg_concurrent`
- `days_parallel_3`
- `longest_sustained_3_seconds`

### Calculated/Derived Fields
- **Daily peak concurrency:** For each day, find max overlapping sessions at any moment (sweep algorithm)
- **Tier buckets:** Count days where peak ∈ [1], [2], [3], [4], [5+]
- **Tier percentages:** `(days_in_tier / 90) * 100`
- **Heatmap intensity:** Normalize peak_daily to CSS opacity (1 → 0.2, 5 → 1.0)
- **Longest sustained 3+:** Convert seconds to human-readable format (minutes/seconds)

### Chart Configuration

**Chart 1: 90-Day Peak-Concurrent Heatmap (13×7 grid)**

```typescript
<div style={{
  display: 'grid',
  gridTemplateColumns: 'repeat(7, 1fr)',
  gap: '4px',
}}>
  {peakDaily.map((peak, i) => (
    <div
      key={i}
      style={{
        width: '100%',
        paddingBottom: '100%',
        background: TR.bgSoft,
        border: `1px solid ${TR.border}`,
        borderRadius: 4,
        opacity: Math.min(1.0, 0.2 + (peak / 5) * 0.8), // Scale 1-5 to 0.2-1.0
        position: 'relative',
      }}
      title={`${date[i]}: ${peak} concurrent`}
    />
  ))}
</div>
```

**Chart 2: Tier Ladder (5-step vertical bar)**

```typescript
<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
  {[
    { tier: 'Solo', range: '1 session' },
    { tier: 'Pair', range: '2 sessions' },
    { tier: 'Trio', range: '3 sessions' },
    { tier: 'Squad', range: '4 sessions' },
    { tier: 'Swarm', range: '5+ sessions' },
  ].map((tier, i) => (
    <div key={tier.tier} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <div style={{
        width: 100,
        height: 24,
        background: TR.bgSoft,
        border: `1px solid ${TR.border}`,
        borderRadius: 4,
        position: 'relative',
      }}>
        {/* Fill proportional to bucket[i].percentage */}
        <div style={{
          height: '100%',
          width: `${bucket[i].percentage}%`,
          background: TR.accent,
          opacity: 0.2 + (i / 5),
        }} />
      </div>
      <span>{bucket[i].sessions_count} days</span>
    </div>
  ))}
</div>
```

### Empty-State Conditions
- **no_sessions:** Show "No concurrent sessions recorded"
- **insufficient_parallelism:** If all days have peak_daily === 1, show message "Always solo—consider multitasking"

### Design Token Usage
- **Typography:**
  - Section title: `TYPOGRAPHY.label`
  - Tier label: `TYPOGRAPHY.bodySm` (12px)
  - Stat metric: `TYPOGRAPHY.mono` (13.5px)
- **Colors:**
  - Heatmap base: `TR.bgSoft` (#13161B)
  - Heatmap fill (scaling): `TR.accent` (#B6FF3C) with opacity 0.2 → 1.0
  - Tier bar fill: `TR.accent`
  - Borders: `TR.border` (#1E232B)
- **Spacing:**
  - Grid gap: 4px
  - Heatmap cell size: responsive
  - Tier bar height: 24px
  - Tier spacing: `SPACING['sm']` (8px)

### Responsive Behavior
- Mobile: Reduce cell size; stack tiers vertically
- Tablet: Maintain grid; side-by-side layout if space allows
- Desktop: Full grid, tier bars with percentage labels

### Deviations from Original Spec
- **peak_daily array:** Not currently pre-computed in `metrics-computation.ts`. Must compute per-day max concurrency in endpoint.
- **Tier buckets:** Derived from peak_daily; not stored in cache.
- **Peak ever timestamp:** May need to be derived from finding the exact moment and date when peak_ever occurred.

---

## Cross-Cutting Concerns

### Data Freshness
All charts use 7d window metrics (not parameterized). Data refreshed hourly via cron job `computeHourlyMetrics()`.

### Empty-State Strategy
- **no_sessions:** Entire page shows message if zero sessions in 90d window
- **need_7d:** Not applicable (all chapters on fixed 90d window)
- **need_2_models:** L3 only; falls back to single-model display
- **need_3_concurrent:** L4 only; tier ladder still renders with zeros

### Chart Library
**Observable Plot** configuration for all visualizations. No external charting library imports needed.

### Performance Considerations
- Daily/hourly data aggregation (sparklines, heatmaps) can be expensive at render time
- Consider pre-computing daily buckets in API endpoint if N > 100K sessions
- Use SVG renders (Observable Plot native) for efficient re-renders

### Accessibility
- All charts have `title` attributes for tooltips
- Numeric values have text fallbacks (not visual-only)
- Color not sole differentiator (use opacity/size/text in addition)
- Proper `aria-label` for section headers

### Mobile Optimization
- Sparklines reduce to single-column layout
- Cell sizes scale responsively
- Touch-friendly tooltips (hover → tap-to-reveal)
- No horizontal scroll; wrap or stack instead

---

## Implementation Checklist

### Phase 1: Data Layer
- [ ] Add `daily_tokens` array (90 days) to `profile_metrics_cache` or compute in endpoint
- [ ] Add `rank_delta_30d` calculation (snapshot comparison)
- [ ] Verify `profile_cadence_cache` hourly/daily patterns are correct
- [ ] Add `peak_daily` array (90 days) to `profile_metrics_cache` or compute in endpoint
- [ ] Add `first_model_date`, `latest_model_date` to models breakdown

### Phase 2: API Endpoints
- [ ] Extend `/api/profile/{handle}` response with L0-L4 sections
- [ ] Ensure all required fields from cache tables are returned
- [ ] Implement computed fields (trend indicators, tier buckets, peak markers)
- [ ] Format dates, durations, percentages for display
- [ ] Implement empty-state logic

### Phase 3: Frontend Components
- [ ] Create `ProfileL0Presence.tsx` with sparkline chart
- [ ] Create `ProfileL1Volume.tsx` with area chart + captions
- [ ] Create `ProfileL2Cadence.tsx` with heatmap + histograms
- [ ] Create `ProfileL3Breadth.tsx` with model strip + sparklines
- [ ] Create `ProfileL4Mastery.tsx` with concurrent heatmap + tier ladder
- [ ] Import Observable Plot and configure per spec
- [ ] Use design tokens (TR, SPACING, TYPOGRAPHY, LAYOUT) consistently

### Phase 4: Styling & Responsive
- [ ] Apply design tokens to all components
- [ ] Implement mobile breakpoints (<640px, 640-1024px, >1024px)
- [ ] Test chart responsiveness and readability
- [ ] Ensure proper spacing and alignment

### Phase 5: Testing & QA
- [ ] Unit tests for computed fields (daily buckets, tiers, trends)
- [ ] Integration tests for API responses
- [ ] Visual tests (responsive, empty states, edge cases)
- [ ] Performance tests (large datasets, chart rendering)

---

## Deviations Summary

| Issue | Impact | Solution |
|-------|--------|----------|
| **Daily token sparkline not pre-computed** | L0 requires runtime bucketing | Compute in endpoint or accept frontend aggregation |
| **rank_delta_30d missing** | L0 shows rank change | Implement snapshot comparison logic in metrics-computation |
| **peak_daily not pre-computed** | L4 heatmap requires computation | Add to endpoint or use session sweep algorithm frontend |
| **Model color palette undefined** | L3 model strip needs colors | Design 10-12 distinct color palette |
| **Trend indicators not cached** | L3 shows ↑↓→ indicators | Compute in endpoint: compare 30d-ago avg vs now avg |
| **Per-model daily tokens not cached** | L3 sparklines need data | Aggregate from `profile_models_breakdown_cache` + sessions |
| **Session duration metrics not cached** | L1 shows median/total time | Compute from `profile_sessions_cache` timestamps |

---

## Next Steps

1. **Review with design:** Confirm L0-L4 narrative and chart types
2. **Determine pre-compute vs. compute strategy:** Decide which fields belong in cache vs. endpoint
3. **Implement data layer:** Extend metrics-computation.ts and API schemas
4. **Build components:** Follow Observable Plot patterns established in existing code
5. **QA & iterate:** Test with real data; refine colors, spacing, responsive behavior

---

**Document Owner:** Design & Engineering Team  
**Last Reviewed:** 2026-05-01  
**Next Review:** Post-implementation QA phase
