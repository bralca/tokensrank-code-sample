# TokensRank Metrics - Simple Reference Guide

**Last Updated:** April 30, 2026  
**How It Works:** Metrics computed once per hour (at :00 UTC). All from real database data.

## What's a Session?

A **session** = one continuous period when a user was actively using Claude or Codex.  
Example: "I opened Claude and worked on a project for 2 hours = 1 session"

A **token** = a small unit of text. Roughly 4 characters = 1 token.  
(More tokens = more processing = more work done with AI)



---

## Simple Metrics Table

| Metric | Stored In | Formula (Plain English) | What It Means | Why This Way |
|--------|-----------|------------------------|--------------|--------------|
| **rank** | profile_metrics_cache | Sort all users by tokens used in time window. User's position in list (1st, 2nd, etc.) | How does this user rank vs others? #1 = most tokens | Token usage is clearest measure of activity level. Direct raw data. |
| **percentile** | profile_metrics_cache | ((Total users - User's rank) / Total users) × 100 | What % of users has fewer tokens than this person? | Easier to understand than position number. "Top 5%" is clearer than "rank #500". |
| **tokens_total** | profile_metrics_cache | Add up all tokens from all sessions in the time window | Total amount of AI work done in this window | Direct measurement. If session has total_tokens recorded, use it. Otherwise, sum input+output+cache+reasoning tokens. |
| **cost_usd_total** | profile_metrics_cache | tokens_total × $0.00001 | How much did this usage cost in dollars? | Shows financial impact. Each token costs roughly one hundredth of a cent. |
| **sessions_count** | profile_metrics_cache | Count how many sessions happened in the time window | How many separate work sessions? | 20 sessions = fragmented work. 1 session = long focus time. Different patterns matter. |
| **days_active** | profile_metrics_cache | Count distinct calendar dates (YYYY-MM-DD) with at least 1 session | On how many different days did user use AI? | Shows consistency. "7 out of 7 days" = every day. "2 out of 7" = sporadic. |
| **avg_tokens_per_session** | profile_metrics_cache | tokens_total ÷ sessions_count | On average, how many tokens per session? | Shows session intensity. 50K tokens/session = long deep work. 500 tokens/session = quick checks. |
| **current_streak** | profile_metrics_cache | Count consecutive days backward from today where user had at least 1 session. Stop at first gap. | How many days in a row has user been active? | "5-day streak" is motivating. Shows current momentum. |
| **longest_streak** | profile_metrics_cache | Find the longest sequence of consecutive calendar days with activity in this window | What's the longest consecutive days of use ever? | Shows capacity for sustained work. A 30-day streak = real commitment. |
| **after_midnight_count** | profile_metrics_cache | Count sessions that started between 00:00-05:59 UTC | How many sessions started very late/early morning? | Indicates work hours or timezone. High count = night owl. |
| **after_midnight_pct** | profile_metrics_cache | (after_midnight_count ÷ sessions_count) × 100 | What % of sessions started after midnight? | Percentage easier to compare. "25%" is clearer than "5 out of 20". |
| **weekend_share** | profile_metrics_cache | Count sessions starting on Saturday or Sunday ÷ total sessions × 100 | What % of sessions happened on weekends? | Work-life balance indicator. High % = works weekends. Low % = weekends off. |
| **avg_concurrent** | profile_metrics_cache | For each moment in the window, count overlapping sessions. Average across entire time span. | On average, how many sessions run simultaneously? | 1.0 = one at a time (sequential). 3.0 = usually 3 together. Shows multitasking ability. |
| **days_parallel_3** | profile_metrics_cache | Count how many calendar days had 3+ sessions running at the same time | On how many days did user have 3+ sessions in parallel? | Power user indicator. Managing multiple tasks = advanced. |
| **longest_sustained_3_seconds** | profile_metrics_cache | Longest continuous time period where 3+ sessions were running together (in seconds) | What's the longest user sustained 3+ parallel sessions? | Shows peak multitasking capacity. Measured in seconds for precision. |
| **Model breakdown** (tokens per model) | profile_models_breakdown_cache | Sum tokens from all sessions using a specific model (e.g., Claude-3.5 only) | How many tokens used with this specific AI model? | Each model has different costs. Shows tool preferences. |
| **claude_tokens** | profile_tools_breakdown_cache | Sum all tokens where source = 'claude' | Total tokens from Claude (all versions) | Shows Claude usage overall. |
| **codex_tokens** | profile_tools_breakdown_cache | Sum all tokens where source = 'codex' | Total tokens from Codex | Shows Codex usage overall. |
| **claude_pct** | profile_tools_breakdown_cache | (claude_tokens ÷ (claude_tokens + codex_tokens)) × 100 | What % of tokens came from Claude? | Quick preference view. If 90%, user heavily prefers Claude. |
| **Top 10 Sessions** | profile_sessions_cache | Take the 10 most recent sessions (sorted newest first) | Recent work activity snapshot | Recent sessions matter more. Shows what user just worked on. |
| **Tokens per session** | profile_sessions_cache | Same token calculation as above, but per individual session | How much work in this specific session? | Lets users see which sessions were heavy (50K tokens) vs light (100 tokens). |
| **Session duration** | profile_sessions_cache | Session start time → Session end time | How long was user working in this session? | Short session = quick task. Long session = deep focus. |
| **hourly_pattern** | profile_cadence_cache | For each hour (0-23 UTC), count how many sessions started in that hour [24 numbers] | When during the day does user work? | Shows work schedule pattern. High at 9am = morning person. |
| **daily_pattern** | profile_cadence_cache | For each day of week (Sun-Sat), count sessions starting on that day [7 numbers] | Which days of week is user most active? | Weekly rhythm. High on weekdays = weekday worker. |
| **connected_count** (homepage) | homepage_stats_cache | Count unique users with at least 1 session in last 24 hours | How many users were active in the last 24 hours? | Platform activity metric. Shows who's using TokensRank right now. |
| **tokens_24h** (homepage) | homepage_stats_cache | Sum all tokens from all users in the last 24 hours | Total platform usage in last 24 hours | Platform scale metric. Shows growth and engagement. |
| **records_today** (homepage) | homepage_stats_cache | Count total sessions created in last 24 hours across all users | How many sessions happened today platform-wide? | Activity metric. More sessions = more engagement. |

---

## Why This Approach?

### The Problem We Solved

If we computed metrics **every time someone asked**:
- Takes 2-5 seconds per request (users wait)
- Repeats same math for 15,000 users (wasted CPU)
- Different numbers at different times (inconsistent)
- Platform gets slower as more users request data

### Our Solution: Pre-compute Hourly

- ✅ Compute everything **once per hour** in background (not on-demand)
- ✅ Same numbers for everyone that hour (consistent)
- ✅ Instant API responses (lookup cached number, no computation)
- ✅ No delays or computation during user requests

### Why These Specific Metrics?

1. **Ranking by Tokens**: Fair comparison. Someone using AI for 10K tokens shows more activity than someone with 10 tokens. Actual usage = best rank.

2. **Three Time Windows (7d/30d/All)**: 
   - New users: Only 1 week of data
   - Regular users: Want to see monthly trends
   - Power users: Want all-time stats
   - One metric suits no one. Three windows suit everyone.

3. **Streaks**: Psychological motivation. "5-day streak" is motivating and memorable. Helps habit tracking.

4. **Concurrency Metrics** (avg_concurrent, days_parallel_3): Real power users can manage multiple tasks simultaneously. Anyone can use 10K tokens over 1 week. But managing 3+ sessions together = advanced skill.

5. **Activity Patterns** (hourly/daily): Shows work schedule. Platform can optimize for peak hours. Users see if they work evenings/weekends.

6. **Cost Breakdown**: Transparency. Users should know what their usage costs.

---

## Data Quality Guarantees

### No Double-Counting (How we prevent duplicates)

**Session Level**: Database prevents same session being inserted twice
- Unique constraint: Can't have two identical (user, session_id, source) records
- Re-ingestion overwrites old, doesn't duplicate

**Calculation Level**: We SUM from clean data
- Each session counted exactly once
- Math is **idempotent** (recomputing = same answer)

### Window Math Always Works

- 7d_tokens ≤ 30d_tokens ≤ all_time_tokens

If not true = we found a bug!

---

## What's Real Data vs Hardcoded?

✅ **Raw Data** (from database):
- Token counts, session counts, activity dates
- Session details (model, source, times, turns)
- Activity patterns (when sessions happen)

✅ **Calculated** (math on raw data):
- Rank, percentile, streaks, percentages
- Concurrent session overlap

⚠️ **Mixed** (raw + price assumptions):
- Cost in USD = (real token count) × (hardcoded price of $0.00001 per token)
  - Token count = real
  - Price rate = hardcoded assumption (needs verification if accuracy matters)

---

**Updated:** April 30, 2026  
**Computation:** Every hour at :00 UTC  
**File:** `apps/api/src/services/metrics-computation.ts`
