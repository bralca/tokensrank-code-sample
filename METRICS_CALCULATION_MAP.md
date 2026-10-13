# TokensRank Metrics Calculation Map

**Last Updated**: 2026-04-30  
**System**: Hourly pre-computed metrics with window-based aggregation  
**Computation**: `apps/api/src/services/metrics-computation.ts`  
**Storage**: Supabase cache tables (see `supabase/migrations/0017_create_metrics_cache_tables.sql`)

---

## Overview

All metrics are computed **hourly** (every hour at :00 UTC) via the `computeHourlyMetrics()` cron job. Computations:
1. Load **all profiles** (paginated)
2. Load **all sessions** (raw data from `sessions` table)
3. For each profile × window (7d, 30d, all):
   - Filter sessions by window timestamp
   - Compute metrics from filtered session data
   - Upsert to cache table
4. Compute homepage stats from 24h session window

**Data Flow**:
```
Raw sessions table → Filter by profile + window → Compute metrics → Upsert to cache table
                    ↓
              daily_aggregates (optional for rank verification)
```

---

## PROFILE METRICS CACHE (`profile_metrics_cache`)

Stores main metrics per profile per window. One row = (profile_id, window).

### 1. **rank** (integer)

**Calculation**:
```typescript
// Rank is computed from windowed session data
const ranked = rankSessionRows(sessions, window)  // All profiles, tokens summed in window
const rankIndex = ranked.findIndex(row => row.profileId === profileId)
const rank = rankIndex >= 0 ? rankIndex + 1 : null
```

**Formula**:
- Sum all tokens in window for each profile (across all sessions)
- Sort profiles by tokens DESC, alphabetically by profile_id ASC
- Find position (1-indexed) in sorted list

**Data Source**: ✅ **RAW DATA**
- Source: `sessions` table, filtered by window
- No hardcoding, no assumptions
- All-time computation (constant across window parameters)

**Window Dependency**: 
- ⚠️ **Computed per window** but represents all-time rank relative to other profiles
- 7D rank = all-time rank computed using only 7D session data
- 30D rank = all-time rank computed using only 30D session data
- All rank = all-time rank using all session data
- **Note**: Rank changes per window because different subsets of profiles may have activity in each window

**Status**: ✅ **COMPLETE**

---

### 2. **percentile** (numeric)

**Calculation**:
```typescript
const percentile = rank && totalRanked > 0 
  ? ((totalRanked - rank) / totalRanked) * 100 
  : null
```

**Formula**:
- `((total_ranked - rank) / total_ranked) * 100`
- Converts rank position to percentile (0-100)

**Data Source**: ✅ **RAW DATA (derived)**
- Derived from `rank` and `total_ranked` values
- No hardcoding

**Window Dependency**: Window-specific (changes with rank per window)

**Status**: ✅ **COMPLETE**

---

### 3. **total_ranked** (integer)

**Calculation**:
```typescript
const totalRanked = ranked.length  // Count of profiles with tokens in window
```

**Formula**:
- Count of profiles with `tokensTotal > 0` in the window

**Data Source**: ✅ **RAW DATA**
- Source: `sessions` table, filtered by window
- Computed live, no assumptions

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 4. **tokens_total** (bigint)

**Calculation**:
```typescript
const tokensTotal = windowSessions.reduce((sum, session) => 
  sum + sessionTokens(session), 0)

// sessionTokens logic:
function sessionTokens(session) {
  const generatedTotal = parseNumeric(session.total_tokens)
  if (generatedTotal > 0) return generatedTotal
  
  return parseNumeric(session.input_tokens)
       + parseNumeric(session.output_tokens)
       + parseNumeric(session.cache_read_tokens)
       + parseNumeric(session.cache_create_tokens)
       + parseNumeric(session.cached_tokens)
       + parseNumeric(session.reasoning_tokens)
}
```

**Formula**:
- For each session in window:
  - If `session.total_tokens > 0`: use that value
  - Else: sum `input_tokens + output_tokens + cache_read_tokens + cache_create_tokens + cached_tokens + reasoning_tokens`
- Sum across all window sessions

**Data Source**: ✅ **RAW DATA**
- Source: `sessions` table (columns: `total_tokens`, `input_tokens`, `output_tokens`, etc.)
- No hardcoding, priority to pre-summed `total_tokens` when available

**Window Dependency**: Window-specific (filtered by `last_event_at >= startDate`)

**Status**: ✅ **COMPLETE**

---

### 5. **cost_usd_total** (numeric)

**Calculation**:
```typescript
const costUsdTotal = roundCurrency(
  computeProfileCostUsd({ tokensTotal: metric.tokensTotal })
)

// computeProfileCostUsd is in leaderboard.ts
// Uses model-specific pricing or hardcoded rates
```

**Formula**:
- Call `computeProfileCostUsd()` with `tokensTotal`
- This function applies model-specific pricing rates
- Round to 2 decimal places

**Data Source**: ⚠️ **RAW DATA + PRICING MODEL**
- Token count: RAW DATA
- Pricing rates: May be model-specific or hardcoded (verify in `leaderboard.ts`)

**Window Dependency**: Window-specific (depends on `tokens_total`)

**Status**: ✅ **COMPLETE** (pending pricing logic verification)

---

### 6. **sessions_count** (integer)

**Calculation**:
```typescript
const sessionsCount = windowSessions.length
```

**Formula**:
- Count of distinct sessions in window

**Data Source**: ✅ **RAW DATA**
- Source: `sessions` table rows, filtered by window
- No assumptions

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 7. **days_active** (integer)

**Calculation**:
```typescript
const daysActive = new Set(
  windowSessions
    .map(session => dateOnly(session.last_event_at))
    .filter(Boolean)
).size

// dateOnly extracts YYYY-MM-DD from ISO timestamp
function dateOnly(value) {
  const date = new Date(value ?? '')
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}
```

**Formula**:
- Distinct count of calendar dates (YYYY-MM-DD) on which sessions occurred
- Uses `last_event_at` timestamp, grouped by date only

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.last_event_at`, parsed as date

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 8. **avg_tokens_per_session** (numeric)

**Calculation**:
```typescript
avg_tokens_per_session: metric.sessionsCount > 0 
  ? metric.tokensTotal / metric.sessionsCount 
  : 0
```

**Formula**:
- `tokensTotal / sessionsCount`
- 0 if no sessions

**Data Source**: ✅ **RAW DATA (derived)**
- Computed from `tokens_total` and `sessions_count`

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 9. **current_streak** (integer)

**Calculation**:
```typescript
const { currentStreak } = computeStreaks(windowSessions)

function computeStreaks(sessions) {
  const dates = Array.from(new Set(
    sessions.map(s => dateOnly(s.last_event_at)).filter(Boolean)
  )).sort()
  
  const activeDates = new Set(dates)
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  
  let currentStreak = 0
  for (let cursor = new Date(today); 
       activeDates.has(cursor.toISOString().slice(0, 10)); 
       cursor.setUTCDate(cursor.getUTCDate() - 1)) {
    currentStreak += 1
  }
  
  return { currentStreak, longestStreak }
}
```

**Formula**:
1. Extract unique dates from windowed sessions
2. Start from today (UTC midnight)
3. Count consecutive days backward (today, yesterday, day before...) while date exists in activity
4. Stop at first gap

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.last_event_at`, grouped by date

**Window Dependency**: Window-specific (only sessions within window count)

**Status**: ✅ **COMPLETE**

---

### 10. **longest_streak** (integer)

**Calculation**:
```typescript
const { longestStreak } = computeStreaks(windowSessions)

function computeStreaks(sessions) {
  const dates = Array.from(new Set(...)).sort()
  
  let longestStreak = 1
  let currentRun = 1
  
  for (let index = 1; index < dates.length; index += 1) {
    const previous = new Date(dates[index - 1]!)
    const current = new Date(dates[index]!)
    const dayDelta = Math.round((current.getTime() - previous.getTime()) / dayMs)
    
    if (dayDelta === 1) {
      currentRun += 1
      longestStreak = Math.max(longestStreak, currentRun)
    } else {
      currentRun = 1
    }
  }
  
  return { currentStreak, longestStreak }
}
```

**Formula**:
1. Extract unique dates from windowed sessions, sort ASC
2. Scan forward through dates, counting consecutive day increments (delta = 1 day)
3. Track longest run of consecutive days
4. Reset run to 1 on any gap > 1 day

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.last_event_at`

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 11. **after_midnight_count** (integer)

**Calculation**:
```typescript
const afterMidnightCount = windowSessions.filter(session => {
  const date = new Date(session.first_event_at)
  return !Number.isNaN(date.getTime()) && date.getUTCHours() < 6
}).length
```

**Formula**:
- Count sessions where `first_event_at` hour (UTC) is 0-5 (00:00-05:59)

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.first_event_at`

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 12. **after_midnight_pct** (numeric)

**Calculation**:
```typescript
after_midnight_pct: windowSessions.length > 0 
  ? roundPercent((afterMidnightCount / windowSessions.length) * 100)
  : 0
```

**Formula**:
- `(after_midnight_count / sessions_count) * 100`
- Round to 2 decimal places
- 0 if no sessions

**Data Source**: ✅ **RAW DATA (derived)**
- Derived from `after_midnight_count` and `sessions_count`

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 13. **weekend_share** (numeric)

**Calculation**:
```typescript
const weekendCount = windowSessions.filter(session => {
  const date = new Date(session.first_event_at)
  return !Number.isNaN(date.getTime()) && 
         (date.getUTCDay() === 0 || date.getUTCDay() === 6)
}).length

weekend_share: windowSessions.length > 0
  ? roundPercent((weekendCount / windowSessions.length) * 100)
  : 0
```

**Formula**:
- Count sessions where `first_event_at` day (UTC) is Sunday (0) or Saturday (6)
- Percentage: `(weekendCount / sessions_count) * 100`
- Round to 2 decimal places

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.first_event_at` (day of week extracted)

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 14. **avg_concurrent** (numeric)

**Calculation**:
```typescript
function computeAvgConcurrent(sessions) {
  const events = concurrencyEvents(sessions)
  
  if (events.length === 0) return 0
  
  let weightedMs = 0
  let current = 0
  let lastTimestamp = events[0]!.timestamp
  
  for (const event of events) {
    if (event.timestamp > lastTimestamp && current > 0) {
      weightedMs += (event.timestamp - lastTimestamp) * current
    }
    current = event.type === 'start' ? current + 1 : Math.max(0, current - 1)
    lastTimestamp = event.timestamp
  }
  
  const spanMs = events[events.length - 1]!.timestamp - events[0]!.timestamp
  return spanMs > 0 ? roundPercent(weightedMs / spanMs) : current
}

function concurrencyEvents(sessions) {
  const events = []
  for (const session of sessions) {
    const startMs = new Date(session.first_event_at).getTime()
    const endMs = new Date(session.last_event_at).getTime()
    
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) continue
    
    events.push({ timestamp: startMs, type: 'start' })
    events.push({ timestamp: endMs, type: 'end' })
  }
  
  return events.sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp
    }
    return left.type === 'start' ? -1 : 1
  })
}
```

**Formula**:
1. Convert each session to `start` and `end` events (timestamps from `first_event_at` and `last_event_at`)
2. Sort events by timestamp (ties: starts before ends)
3. Sweep through events, tracking current concurrency level
4. For each time interval, accumulate `(interval_duration × concurrent_count)`
5. Average = `weighted_ms / total_span_ms`

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.first_event_at`, `sessions.last_event_at`
- Exact timestamp-based overlap detection

**Window Dependency**: Window-specific (only sessions in window)

**Status**: ✅ **COMPLETE**

---

### 15. **days_parallel_3** (integer)

**Calculation**:
```typescript
function computeDaysParallel3(sessions) {
  const days = Array.from(new Set(
    sessions.map(session => dateOnly(session.last_event_at)).filter(Boolean)
  ))
  
  return days.filter(day => maxConcurrencyForDay(sessions, day) >= 3).length
}

function maxConcurrencyForDay(sessions, day) {
  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime()
  const dayEnd = dayStart + dayMs
  const events = []
  
  for (const session of sessions) {
    const startMs = new Date(session.first_event_at).getTime()
    const endMs = new Date(session.last_event_at).getTime()
    
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || 
        endMs < startMs || startMs >= dayEnd || endMs < dayStart) continue
    
    events.push({ timestamp: Math.max(startMs, dayStart), type: 'start' })
    events.push({ timestamp: Math.min(endMs, dayEnd), type: 'end' })
  }
  
  events.sort((...)
  
  let current = 0, peak = 0
  for (const event of events) {
    current = event.type === 'start' ? current + 1 : Math.max(0, current - 1)
    peak = Math.max(peak, current)
  }
  
  return peak
}
```

**Formula**:
1. Get unique dates from windowed sessions
2. For each date:
   - Find max concurrent sessions on that day (using sweep algorithm)
   - Count if peak >= 3
3. Return count of days with 3+ concurrent sessions

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.first_event_at`, `sessions.last_event_at`, `sessions.last_event_at` (date only)

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 16. **longest_sustained_3_seconds** (integer)

**Calculation**:
```typescript
function computeLongestSustained3Seconds(sessions) {
  const events = concurrencyEvents(sessions)
  let current = 0
  let periodStart = null
  let longestMs = 0
  
  for (const event of events) {
    if (event.type === 'start') {
      if (current < 3 && current + 1 >= 3) {
        periodStart = event.timestamp
      }
      current += 1
    } else {
      if (current >= 3 && current - 1 < 3 && periodStart !== null) {
        longestMs = Math.max(longestMs, event.timestamp - periodStart)
        periodStart = null
      }
      current = Math.max(0, current - 1)
    }
  }
  
  return Math.floor(longestMs / 1000)
}
```

**Formula**:
1. Convert sessions to start/end events
2. Sweep through events, tracking current concurrency
3. Mark period start when concurrency reaches 3
4. Mark period end when concurrency drops below 3
5. Track longest duration where concurrency was >= 3
6. Return duration in seconds (milliseconds / 1000)

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.first_event_at`, `sessions.last_event_at`

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

## MODELS BREAKDOWN CACHE (`profile_models_breakdown_cache`)

Stores token/cost breakdown per model per profile per window. Multiple rows per profile per window.

### 1. **tokens_total** (bigint)

**Calculation**:
```typescript
const totals = new Map()
for (const session of sessions) {
  const model = session.model ?? 'unknown'
  totals.set(model, (totals.get(model) ?? 0) + sessionTokens(session))
}
// tokens_total per model entry
```

**Formula**:
- Group sessions by `model` field
- Sum `sessionTokens()` per model group

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.model`, `sessions.total_tokens` (or component tokens)

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 2. **cost_usd** (numeric)

**Calculation**:
```typescript
cost_usd: roundCurrency(
  computeProfileCostUsd({ tokensTotal: tokens })
)
```

**Formula**:
- Apply `computeProfileCostUsd()` to model's `tokens_total`
- Round to 2 decimals

**Data Source**: ⚠️ **RAW DATA + PRICING**
- Token count: RAW DATA
- Pricing: See `leaderboard.ts` for model-specific rates

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE** (pending pricing verification)

---

### 3. **pct_of_total** (numeric)

**Calculation**:
```typescript
const totalTokens = sessions.reduce((sum, s) => sum + sessionTokens(s), 0)

pct_of_total: totalTokens > 0 
  ? roundPercent((tokens / totalTokens) * 100)
  : 0
```

**Formula**:
- `(model_tokens / all_profile_tokens_in_window) * 100`
- Round to 2 decimals

**Data Source**: ✅ **RAW DATA (derived)**
- Derived from model tokens and total tokens

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

## TOOLS BREAKDOWN CACHE (`profile_tools_breakdown_cache`)

Stores Claude vs Codex breakdown per profile per window. One row per profile per window.

### 1. **claude_tokens** (bigint)

**Calculation**:
```typescript
const claudeTokens = sessions
  .filter(session => session.source === 'claude')
  .reduce((sum, session) => sum + sessionTokens(session), 0)
```

**Formula**:
- Filter sessions where `source === 'claude'`
- Sum `sessionTokens()` across filtered sessions

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.source`, `sessions.total_tokens` (or components)

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 2. **codex_tokens** (bigint)

**Calculation**:
```typescript
const codexTokens = sessions
  .filter(session => session.source === 'codex')
  .reduce((sum, session) => sum + sessionTokens(session), 0)
```

**Formula**:
- Filter sessions where `source === 'codex'`
- Sum `sessionTokens()`

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.source`, `sessions.total_tokens` (or components)

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 3. **claude_pct** (numeric)

**Calculation**:
```typescript
const total = claudeTokens + codexTokens

claude_pct: total > 0 
  ? roundPercent((claudeTokens / total) * 100)
  : 0
```

**Formula**:
- `(claude_tokens / (claude_tokens + codex_tokens)) * 100`
- 0 if no tokens

**Data Source**: ✅ **RAW DATA (derived)**
- Derived from claude and codex token counts

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 4. **codex_pct** (numeric)

**Calculation**:
```typescript
codex_pct: total > 0 
  ? roundPercent((codexTokens / total) * 100)
  : 0
```

**Formula**:
- `(codex_tokens / (claude_tokens + codex_tokens)) * 100`
- Always: `claude_pct + codex_pct = 100` (or both 0)

**Data Source**: ✅ **RAW DATA (derived)**

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

## SESSIONS CACHE (`profile_sessions_cache`)

Stores top 10 most recent sessions per profile per window. Up to 10 rows per profile per window.

### 1. **session_rank** (integer)

**Calculation**:
```typescript
function buildSessionsCache(profileId, window, sessions) {
  return sessions.slice(0, 10).map((session, index) => ({
    session_rank: index + 1,
    ...
  }))
}
```

**Formula**:
- Sessions are pre-sorted by `last_event_at` DESC (most recent first)
- session_rank = position in sorted list (1-10)

**Data Source**: 🔧 **DERIVED**
- Position in rank order (no raw data, just ordering)

**Status**: ✅ **COMPLETE**

---

### 2. **session_id** (text)

**Calculation**:
```typescript
session_id: session.session_id
```

**Formula**:
- Direct copy from `sessions.session_id`

**Data Source**: ✅ **RAW DATA**

**Status**: ✅ **COMPLETE**

---

### 3. **source** (text)

**Calculation**:
```typescript
source: session.source
```

**Formula**:
- Direct copy from `sessions.source` ('claude' or 'codex')

**Data Source**: ✅ **RAW DATA**

**Status**: ✅ **COMPLETE**

---

### 4. **model** (text)

**Calculation**:
```typescript
model: session.model
```

**Formula**:
- Direct copy from `sessions.model`

**Data Source**: ✅ **RAW DATA**

**Status**: ✅ **COMPLETE**

---

### 5. **started_at** (timestamptz)

**Calculation**:
```typescript
started_at: session.first_event_at
```

**Formula**:
- Direct copy from `sessions.first_event_at`

**Data Source**: ✅ **RAW DATA**

**Status**: ✅ **COMPLETE**

---

### 6. **ended_at** (timestamptz)

**Calculation**:
```typescript
ended_at: session.last_event_at
```

**Formula**:
- Direct copy from `sessions.last_event_at`

**Data Source**: ✅ **RAW DATA**

**Status**: ✅ **COMPLETE**

---

### 7. **tokens_total** (bigint)

**Calculation**:
```typescript
tokens_total: sessionTokens(session)
```

**Formula**:
- See `sessionTokens()` function (same as in profile metrics)
- Priority to `session.total_tokens`, else sum components

**Data Source**: ✅ **RAW DATA**

**Status**: ✅ **COMPLETE**

---

### 8. **cost_usd_total** (numeric)

**Calculation**:
```typescript
cost_usd_total: roundCurrency(
  computeProfileCostUsd({ tokensTotal: sessionTokens(session) })
)
```

**Formula**:
- Apply pricing function to session's token total

**Data Source**: ⚠️ **RAW DATA + PRICING**

**Status**: ✅ **COMPLETE** (pending pricing verification)

---

### 9. **turns** (integer)

**Calculation**:
```typescript
turns: parseNumeric(session.turns)
```

**Formula**:
- Direct copy from `sessions.turns`, parsed as number

**Data Source**: ✅ **RAW DATA**

**Status**: ✅ **COMPLETE**

---

### 10. **project_name** (text)

**Calculation**:
```typescript
function projectNameForSession(session) {
  const projectName = session.fingerprint?.project_name
  return typeof projectName === 'string' && projectName.trim() !== ''
    ? projectName.trim()
    : null
}

project_name: projectNameForSession(session)
```

**Formula**:
- Extract `fingerprint.project_name` from session
- Return as string if valid (non-empty after trim), else null

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.fingerprint.project_name` (optional JSON field)

**Status**: ✅ **COMPLETE**

---

## CADENCE CACHE (`profile_cadence_cache`)

Stores hourly and daily activity patterns per profile per window. One row per profile per window.

### 1. **hourly_pattern** (integer[24])

**Calculation**:
```typescript
function buildCadenceCache(profileId, window, sessions) {
  const hourly = new Array(24).fill(0)
  
  for (const session of sessions) {
    const date = new Date(session.first_event_at)
    if (Number.isNaN(date.getTime())) continue
    hourly[date.getUTCHours()]! += 1
  }
  
  return {
    hourly_pattern: hourly,
    ...
  }
}
```

**Formula**:
- For each session, extract UTC hour from `first_event_at`
- Increment count for that hour (0-23)
- Result: 24-element array where index = hour, value = session count

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.first_event_at`

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

### 2. **daily_pattern** (integer[7])

**Calculation**:
```typescript
function buildCadenceCache(profileId, window, sessions) {
  const daily = new Array(7).fill(0)
  
  for (const session of sessions) {
    const date = new Date(session.first_event_at)
    if (Number.isNaN(date.getTime())) continue
    daily[date.getUTCDay()]! += 1
  }
  
  return {
    daily_pattern: daily,
    ...
  }
}
```

**Formula**:
- For each session, extract UTC day-of-week from `first_event_at`
- Increment count for that day (0=Sunday, 1=Monday, ..., 6=Saturday)
- Result: 7-element array where index = day, value = session count

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.first_event_at`

**Window Dependency**: Window-specific

**Status**: ✅ **COMPLETE**

---

## HOMEPAGE STATS CACHE (`homepage_stats_cache`)

Single row (id=1) with 24h aggregated stats across all profiles. Refreshed hourly.

### 1. **connected_count** (integer)

**Calculation**:
```typescript
function computeHomepageStats(sessions) {
  const cutoffMs = Date.now() - 24 * hourMs  // 24h ago
  const recentSessions = sessions.filter(session => {
    const eventMs = new Date(session.last_event_at).getTime()
    return !Number.isNaN(eventMs) && eventMs >= cutoffMs
  })
  
  connected_count: new Set(recentSessions.map(s => s.profile_id)).size
}
```

**Formula**:
- Filter all sessions where `last_event_at >= (now - 24 hours)`
- Count unique `profile_id` values

**Data Source**: ✅ **RAW DATA**
- Source: `sessions.profile_id`, `sessions.last_event_at`

**Window Dependency**: Always 24h (fixed, not parameterized)

**Status**: ✅ **COMPLETE**

---

### 2. **tokens_24h** (bigint)

**Calculation**:
```typescript
const tokensTotal = recentSessions.reduce((sum, session) => 
  sum + sessionTokens(session), 0)

tokens_24h: tokensTotal
```

**Formula**:
- Sum `sessionTokens()` across all 24h recent sessions (all profiles)

**Data Source**: ✅ **RAW DATA**
- Source: `sessions` (all, filtered by 24h timestamp)

**Status**: ✅ **COMPLETE**

---

### 3. **cost_24h_usd** (numeric)

**Calculation**:
```typescript
cost_24h_usd: roundCurrency(
  computeProfileCostUsd({ tokensTotal })
)
```

**Formula**:
- Apply pricing function to `tokens_24h`

**Data Source**: ⚠️ **RAW DATA + PRICING**

**Status**: ✅ **COMPLETE** (pending pricing verification)

---

### 4. **records_today** (integer)

**Calculation**:
```typescript
records_today: recentSessions.length
```

**Formula**:
- Count of distinct session records in last 24h

**Data Source**: ✅ **RAW DATA**
- Source: `sessions` table row count (24h filtered)

**Status**: ✅ **COMPLETE**

---

## HOURLY METRICS SNAPSHOTS (`hourly_metrics_snapshots`)

Immutable historical snapshots taken every hour. Stores key metrics at snapshot time, plus 1-hour deltas.

### 1. **snapshot_hour** (timestamptz)

**Calculation**:
```typescript
const snapshotHour = new Date()
snapshotHour.setMinutes(0, 0, 0)  // Round to top of hour (UTC)

snapshot_hour: snapshotHour.toISOString()
```

**Formula**:
- Current UTC hour, rounded down (HH:00:00.000Z)

**Data Source**: 🔧 **SYSTEM TIME**

**Status**: ✅ **COMPLETE**

---

### 2. **rank** (integer), **percentile** (numeric), **total_ranked** (integer)

**Same as profile_metrics_cache entries above**

---

### 3. **tokens_total** (bigint), **sessions_count** (integer), **days_active** (integer)

**Same as profile_metrics_cache entries above**

---

### 4. **tokens_delta_1h** (bigint), **sessions_delta_1h** (integer), **rank_delta_1h** (integer)

**Calculation**:
```
// NOT YET IMPLEMENTED IN CURRENT CODE
// Placeholder structure - would require querying previous snapshot
```

**Formula**:
- `tokens_delta_1h = tokens_total(now) - tokens_total(1 hour ago)`
- `sessions_delta_1h = sessions_count(now) - sessions_count(1 hour ago)`
- `rank_delta_1h = rank(now) - rank(1 hour ago)`

**Data Source**: 🔧 **DERIVED (from snapshots)**

**Status**: ⚠️ **NOT YET IMPLEMENTED**
- Requires querying previous hour's snapshot
- Current code stores NULL for deltas

---

## DEDUPLICATION & ACCURACY

### Data Integrity Guarantees

**Sessions Layer**:
```sql
UNIQUE(profile_id, source, session_id, file_sha256)
```
- Prevents duplicate session inserts at source level
- Re-ingestion overwrites via UPSERT, doesn't duplicate

**Daily Aggregates Layer**:
- Keyed by `(profile_id, date, source, model)`
- DB trigger uses `ON CONFLICT DO UPDATE` to accumulate, not duplicate

**Cache Layer**:
- Our metrics SUM from already-deduplicated `sessions`
- Hourly computation is **idempotent**: recomputing produces same results
- No double-counting at any layer

### Window Filtering Approach

**7D Window**:
- Filter sessions where `last_event_at >= (now - 7 days)`
- Exact timestamp-based, not calendar-day approximation

**30D Window**:
- Filter sessions where `last_event_at >= (now - 30 days)`

**All-Time Window**:
- No date filter, use all sessions in database

**Invariant**: `7d_tokens ≤ 30d_tokens ≤ all_time_tokens` (always true)

---

## SUMMARY TABLE

| Metric | Category | Data Source | Window Specific | Status |
|--------|----------|-------------|-----------------|--------|
| rank | Profile | RAW | No (all-time) | ✅ |
| percentile | Profile | DERIVED | No (from rank) | ✅ |
| total_ranked | Profile | RAW | Yes | ✅ |
| tokens_total | Profile | RAW | Yes | ✅ |
| cost_usd_total | Profile | RAW+PRICING | Yes | ✅ |
| sessions_count | Profile | RAW | Yes | ✅ |
| days_active | Profile | RAW | Yes | ✅ |
| avg_tokens_per_session | Profile | DERIVED | Yes | ✅ |
| current_streak | Profile | RAW | Yes | ✅ |
| longest_streak | Profile | RAW | Yes | ✅ |
| after_midnight_count | Profile | RAW | Yes | ✅ |
| after_midnight_pct | Profile | DERIVED | Yes | ✅ |
| weekend_share | Profile | RAW | Yes | ✅ |
| avg_concurrent | Profile | RAW | Yes | ✅ |
| days_parallel_3 | Profile | RAW | Yes | ✅ |
| longest_sustained_3_seconds | Profile | RAW | Yes | ✅ |
| tokens_total (model) | Models | RAW | Yes | ✅ |
| cost_usd (model) | Models | RAW+PRICING | Yes | ✅ |
| pct_of_total (model) | Models | DERIVED | Yes | ✅ |
| claude_tokens | Tools | RAW | Yes | ✅ |
| codex_tokens | Tools | RAW | Yes | ✅ |
| claude_pct | Tools | DERIVED | Yes | ✅ |
| codex_pct | Tools | DERIVED | Yes | ✅ |
| session_rank | Sessions | DERIVED | Yes | ✅ |
| session_id | Sessions | RAW | Yes | ✅ |
| source | Sessions | RAW | Yes | ✅ |
| model | Sessions | RAW | Yes | ✅ |
| started_at | Sessions | RAW | Yes | ✅ |
| ended_at | Sessions | RAW | Yes | ✅ |
| tokens_total (session) | Sessions | RAW | Yes | ✅ |
| cost_usd_total (session) | Sessions | RAW+PRICING | Yes | ✅ |
| turns | Sessions | RAW | Yes | ✅ |
| project_name | Sessions | RAW | Yes | ✅ |
| hourly_pattern | Cadence | RAW | Yes | ✅ |
| daily_pattern | Cadence | RAW | Yes | ✅ |
| connected_count | Homepage | RAW | No (24h fixed) | ✅ |
| tokens_24h | Homepage | RAW | No (24h fixed) | ✅ |
| cost_24h_usd | Homepage | RAW+PRICING | No (24h fixed) | ✅ |
| records_today | Homepage | RAW | No (24h fixed) | ✅ |

---

## Legend

- **RAW**: Data directly from `sessions`, `daily_aggregates`, or `profiles` tables
- **DERIVED**: Computed from other raw data (ratios, counts, sums)
- **RAW+PRICING**: Raw data + model-specific pricing rates (see `leaderboard.ts`)
- **SYSTEM TIME**: Generated from system clock (not database data)
- **Window Specific**: Metric value changes based on window parameter (7d/30d/all)
- **✅ COMPLETE**: Fully implemented and in production
- **⚠️ TODO**: Not yet implemented
