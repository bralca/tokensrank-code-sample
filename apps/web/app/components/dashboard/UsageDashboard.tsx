"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BuilderAvatar } from './BuilderAvatar';
import { UsageInsights } from './UsageInsights';
import { UsageRecap } from './UsageRecap';
import { EvidencePanel, CategoryStandings } from './EvidencePanel';
import { observedActivity } from '../../lib/observed-activity';
import { unpricedModelsInPeriod } from '../../lib/usage-pricing';
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowUpRight,
  ArrowRight,
  ChevronDown,
  Sparkles,
  Layers3,
  CalendarDays,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ProfileResponse, ProfileWindow } from "@tokensrank/shared";
import { LocalRefresh } from "./LocalRefresh";
import { ProjectFooter } from "./Brand";
import { modelLabel } from "../LeaderboardTable";

export const compact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
export const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 10 ? 2 : 0,
    maximumFractionDigits: value > 0 && value < 10 ? 2 : 0,
  }).format(value);
const colors = [
  "var(--accent)",
  "#82776c",
  "#b8a89a",
  "#bc773f",
  "#5f6257",
  "#d4c8ba",
];
const periods: [ProfileWindow, string][] = [
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["all", "All time"],
];
function modelName(name: string) {
  return modelLabel(name);
}
function shortDate(date: string) {
  return new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric" },
  );
}

export function UsageDashboard({
  profile,
  local,
}: {
  profile: ProfileResponse;
  local: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<"overview" | "models" | "activity">(
    "overview",
  );
  const [metric, setMetric] = useState<"tokens" | "sessions">("tokens");
  const [allModels, setAllModels] = useState(false);
  const models = [...profile.models.models].sort((a, b) => b.tokens - a.tokens);
  const top = models[0];
  const stats = profile.at_glance;
  const days = useMemo(() => {
    const all = profile.cadence.days;
    return profile.window === "all"
      ? all
      : all.slice(-{ "7d": 7, "30d": 30, "24h": 1 }[profile.window]);
  }, [profile]);
  const chartDays = useMemo(() => {
    const size = days.length > 100 ? 7 : 1;
    return Array.from({ length: Math.ceil(days.length / size) }, (_, i) => {
      const chunk = days.slice(i * size, (i + 1) * size);
      return {
        date: chunk[0].date,
        tokens: chunk.reduce((n, d) => n + d.tokens_total, 0),
        sessions: chunk.reduce((n, d) => n + d.sessions_count, 0),
      };
    });
  }, [days]);
  const activeDays = days.filter((d) => d.tokens_total > 0).length;
  const observed=observedActivity(days);
  const sources=profile.evidence?.usage?.sources??[];
  const eventDates=sources.length>0&&sources.every(s=>s.daily_basis==='event_dates');
  const unpricedModels=unpricedModelsInPeriod(profile);
  const partialValue=unpricedModels.size>0;
  const peak = [...days].sort((a, b) => b.tokens_total - a.tokens_total)[0];
  const name =
    profile.identity.display_name ||
    profile.identity.name ||
    profile.identity.handle;
  const label = periods.find(([p]) => p === profile.window)?.[1] ?? "24 hours";
  return (
    <div className="dash-content">
      <div className="dash-page-title">
        <div className="dash-profile-identity">
          {(!local || profile.identity.avatar_url) && <span className="dash-entry-avatar"><BuilderAvatar name={name} url={profile.identity.avatar_url}/></span>}
          <div>
          <h1>
            {local ? "Your usage" : name}
          </h1>
          <p className="dash-subtitle">
            {local
              ? "Usage from your local tools. Raw files stay on this device."
              : `@${profile.identity.handle} · Published AI usage`}
          </p>
          </div>
        </div>
        {local ? (
          <LocalRefresh />
        ) : (
          <div className="dash-public-rank">
            <span className="dash-eyebrow">Overall rank</span>
            <strong>
              {profile.headline.rank ? `#${profile.headline.rank}` : "—"}
            </strong>
          </div>
        )}
      </div>
      {local && profile.usage_recap && <UsageRecap recap={profile.usage_recap}/>}
      {local && profile.usage_recap && <div className="recap-history-heading" id="usage-history"><h2>Your history</h2><span>{label} · includes today (UTC)</span></div>}
      <div className="dash-toolbar">
        <div className="dash-tabs" role="tablist" aria-label="Usage sections">
          {(["overview", "models", "activity"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              tabIndex={tab === t ? 0 : -1}
              onKeyDown={(event) => {
                const keys = ["overview", "models", "activity"] as const;
                const index = keys.indexOf(t);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % 3
                    : event.key === "ArrowLeft"
                      ? (index + 2) % 3
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? 2
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                setTab(keys[next]);
                (
                  event.currentTarget.parentElement?.children[
                    next
                  ] as HTMLButtonElement
                )?.focus();
              }}
              aria-selected={tab === t}
              aria-controls={`usage-${t}`}
              onClick={() => setTab(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="dash-periods" aria-label="Time range">
          {periods.map(([p, title]) => (
            <button
              aria-pressed={profile.window === p}
              key={p}
              onClick={() =>
                router.push(`${pathname}?window=${p}`, { scroll: false })
              }
            >
              {title}
            </button>
          ))}
        </div>
      </div>
      {!local && tab === 'overview' && <CategoryStandings profile={profile}/>}
      <section className="dash-stat-grid" aria-label="Usage highlights">
        <div className="dash-stat">
          <span>Total tokens</span>
          <strong>{compact(stats.tokens_total)}</strong>
          <small>Input, output & cached context</small>
        </div>
        <div className="dash-stat">
          <span>
            {partialValue?'Partial API value':'API value'}{" "}
            <span
              title="Estimated value at API rates. Your subscription bill may be different."
              className="dash-info"
            >
              i
            </span>
          </span>
          <strong>{money(stats.cost_usd_total)}</strong>
          <small>Estimated at model API prices</small>
        </div>
        <div className="dash-stat">
          <span>Sessions</span>
          <strong>{compact(stats.sessions_count)}</strong>
          <small>{activeDays ? `${activeDays.toLocaleString()} ${eventDates?'days with recorded usage':'submitted usage dates'}` : stats.tokens_total > 0 ? "Daily history unavailable" : "No activity in this period"}</small>
        </div>
        <div className="dash-stat">
          <span>Models used</span>
          <strong>{profile.models.distinct}</strong>
          <small>
            {top
              ? `${modelName(top.name)} leads by tokens`
              : "No models in this period"}
          </small>
        </div>
      </section>
      <EvidencePanel profile={profile} local={local}/>
      <div id={`usage-${tab}`} role="tabpanel" aria-label={tab}>
        {tab === "overview" && (
          <>
            <div className="dash-overview-grid">
              <section className="dash-card dash-chart-card">
                <div className="dash-card-heading">
                  <div>
                    <p className="dash-eyebrow">Token usage</p>
                    <h2>Usage over time</h2>
                  </div>
                  <div className="dash-mini-toggle">
                    {(["tokens", "sessions"] as const).map((m) => (
                      <button
                        key={m}
                        aria-pressed={metric === m}
                        onClick={() => setMetric(m)}
                      >
                        {m === "tokens" ? "Tokens" : "Sessions"}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="dash-chart-sub">
                  {days.length > 100 ? "Weekly" : "Daily"} activity ·{" "}
                  {label.toLowerCase()}
                </p>
                {chartDays.some((day) => day.tokens > 0 || day.sessions > 0) ? (
                  <div
                    className="dash-chart"
                    aria-label={`${metric} over time`}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={chartDays}
                        margin={{ top: 20, right: 8, left: -15, bottom: 0 }}
                      >
                        <defs>
                          <linearGradient
                            id="usage-fill"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor="var(--accent)"
                              stopOpacity={0.22}
                            />
                            <stop
                              offset="100%"
                              stopColor="var(--accent)"
                              stopOpacity={0.01}
                            />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke="var(--line)" />
                        <XAxis
                          dataKey="date"
                          tickFormatter={shortDate}
                          axisLine={false}
                          tickLine={false}
                          minTickGap={45}
                          tick={{ fontSize: 13, fill: "var(--muted)" }}
                        />
                        <YAxis
                          tickFormatter={compact}
                          axisLine={false}
                          tickLine={false}
                          tick={{ fontSize: 13, fill: "var(--muted)" }}
                          width={65}
                        />
                        <Tooltip
                          labelFormatter={(v) => shortDate(String(v))}
                          formatter={(v) => [
                            Number(v).toLocaleString(),
                            metric === "tokens" ? "Tokens" : "Sessions",
                          ]}
                          contentStyle={{
                            borderRadius: 12,
                            color: "var(--ink)",
                            background: "var(--page)",
                            border: "1px solid var(--line)",
                            fontSize: 14,
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey={metric}
                          stroke="var(--accent)"
                          strokeWidth={2}
                          fill="url(#usage-fill)"
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="dash-empty-chart">
                    <Layers3 size={28} />
                    <h3>
                      {stats.tokens_total > 0
                        ? "Daily history unavailable"
                        : "No usage in this period"}
                    </h3>
                    <p>
                      {stats.tokens_total > 0
                        ? "Totals are available, but daily history is missing for this period."
                        : `Try a wider time range${local ? " or refresh your local files." : "."}`}
                    </p>
                  </div>
                )}
                <div className="dash-chart-footer">
                  <span>
                    <i className="dash-legend-dot" />
                    {metric === "tokens" ? "Tokens used" : "Sessions"}
                  </span>
                  <span>
                    {days[0]
                      ? `${shortDate(days[0].date)} – ${shortDate(days.at(-1)!.date)}`
                      : stats.tokens_total > 0
                        ? "No daily history"
                        : "No activity yet"}
                  </span>
                </div>
              </section>
              <section className="dash-card dash-model-card">
                <div className="dash-card-heading">
                  <div>
                    <p className="dash-eyebrow">Model breakdown</p>
                    <h2>
                      Top models
                    </h2>
                  </div>
                  <Layers3 size={18} color="var(--muted)" />
                </div>
                <p className="dash-chart-sub">
                  Share of tokens · {label.toLowerCase()}
                </p>
                <div className="dash-model-list">
                  {models.slice(0, 4).map((m, i) => (
                    <div className="dash-model-row" key={m.name}>
                      <div>
                        <span
                          className="dash-model-icon"
                          style={{
                            color: colors[i],
                            background: `color-mix(in srgb, ${colors[i]} 10%, transparent)`,
                          }}
                        >
                          {i === 0 ? (
                            <Sparkles size={16} />
                          ) : (
                            <Layers3 size={15} />
                          )}
                        </span>
                        <span title={m.name}>{modelName(m.name)}</span>
                        <strong>{(m.share * 100).toFixed(1)}%</strong>
                      </div>
                      <div className="dash-meter">
                        <span
                          style={{
                            width: `${m.share * 100}%`,
                            background: colors[i],
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  {!models.length && (
                    <p className="dash-muted">
                      Models appear after your first import.
                    </p>
                  )}
                </div>
                <button
                  className="dash-text-button"
                  onClick={() => setTab("models")}
                >
                  Explore all models <ArrowRight size={15} />
                </button>
              </section>
            </div>
            <div className="dash-bottom-grid">
              <section className="dash-card dash-insight">
                <span className="dash-insight-icon"><CalendarDays size={22} /></span>
                <div>
                  <p className="dash-eyebrow">Peak day</p>
                  <h3>{peak?.tokens_total ? `${compact(peak.tokens_total)} tokens · ${shortDate(peak.date)}` : stats.tokens_total > 0 ? "Daily history unavailable" : "No daily activity"}</h3>
                  <p>{peak?.tokens_total ? `${peak.sessions_count.toLocaleString()} sessions last observed on this day.` : stats.tokens_total > 0 ? "Published totals do not include daily activity for this period." : "Daily totals appear after importing usage."}</p>
                </div>
              </section>
              <section className="dash-card dash-tools">
                <p className="dash-eyebrow">Usage by tool</p>
                <div className="dash-tool-strip">
                  {profile.tools.items
                    .filter((t) => t.tokens_total > 0)
                    .map((tool, i) => (
                      <div key={tool.source}>
                        <span>
                          <i style={{ background: colors[i] }} />
                          {
                            {
                              claude: "Claude",
                              codex: "Codex",
                              opencode: "OpenCode",
                            }[tool.source]
                          }
                        </span>
                        <strong>{compact(tool.tokens_total)}</strong>
                        <small>tokens</small>
                      </div>
                    ))}
                  {!stats.tokens_total && (
                    <p className="dash-muted">Claude · Codex · OpenCode</p>
                  )}
                </div>
              </section>
            </div>
            {local && <UsageInsights profile={profile}/>}
            {local && !profile.usage_recap && (
              <div className="dash-share-banner">
                <div>
                  <span className="dash-community-icon">
                    <ArrowUpRight size={21} />
                  </span>
                  <div>
                    <h3>Publish your usage</h3>
                    <p>
                      Share a summary and see how the community uses AI. Your
                      conversations stay private.
                    </p>
                  </div>
                </div>
                <Link className="dash-button" href="/local/publish">
                  Review publishing <ArrowUpRight size={15} />
                </Link>
              </div>
            )}
          </>
        )}
        {tab === "models" && (
          <section className="dash-card">
            {!local&&<CategoryStandings profile={profile}/>}
            <div className="dash-card-heading">
              <div>
                <p className="dash-eyebrow">Model breakdown</p>
                <h2>Models</h2>
              </div>
              <span className="dash-muted">
                {profile.models.distinct} {profile.models.distinct === 1 ? 'model' : 'models'} · {label}
              </span>
            </div>
            <div className="dash-stacked-bar">
              {models.map((m, i) => (
                <span
                  title={`${m.name}: ${(m.share * 100).toFixed(1)}%`}
                  key={m.name}
                  style={{
                    width: `${m.share * 100}%`,
                    background: colors[i % colors.length],
                  }}
                />
              ))}
            </div>
            <div className="dash-table-scroll">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Share</th>
                    <th>Tokens</th>
                    <th>API value</th>
                  </tr>
                </thead>
                <tbody>
                  {models.slice(0, allModels ? undefined : 8).map((m, i) => (
                    <tr key={m.name}>
                      <td>
                        <i
                          className="dash-legend-dot"
                          style={{ background: colors[i % colors.length] }}
                        />
                        {local ? modelName(m.name) : <Link href={`/models/by-name?model=${encodeURIComponent(m.name)}`}>{modelName(m.name)} ↗</Link>}
                      </td>
                      <td>{(m.share * 100).toFixed(1)}%</td>
                      <td>{compact(m.tokens)}</td>
                      <td>{unpricedModels.has(m.name)?(m.cost>0?`${money(m.cost)} partial`:'Unavailable'):money(m.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {models.length > 8 && (
              <button
                className="dash-text-button"
                onClick={() => setAllModels(!allModels)}
              >
                {allModels
                  ? "Show fewer models"
                  : `Show all ${models.length} models`}{" "}
                <ChevronDown size={15} />
              </button>
            )}
            <p className="dash-footnote">
              API value is an estimate, not a subscription bill. Cached context
              is included in token totals.
            </p>
          </section>
        )}
        {tab === "activity" && (
          <>
            <div className="activity-highlights">
              <div><strong>{eventDates?observed.activeDays:'—'}</strong><span>days with recorded usage</span></div>
              <div><strong>{eventDates?observed.activeWeeks:'—'}</strong><span>calendar weeks with usage</span></div>
              <p>{eventDates?'Counted from distinct event dates in UTC. No points for session count or time spent.':'Activity comparisons are unavailable until this record includes event-based daily totals.'} Gaps may mean missing files.</p>
            </div>
            <section className="dash-card">
              <div className="dash-card-heading">
                <div>
                  <p className="dash-eyebrow">Activity</p>
                  <h2>Daily activity</h2>
                </div>
                <span className="dash-muted">
                  {activeDays} active days in this view
                </span>
              </div>
              <div
                className="dash-heatmap"
                role="img"
                aria-label={`Daily activity: ${activeDays} active days. ${peak?.tokens_total ? `Peak ${shortDate(peak.date)}, ${compact(peak.tokens_total)} tokens.` : "No activity yet."}`}
              >
                {days.map((d) => (
                  <div
                    key={d.date}
                    title={`${shortDate(d.date)}: ${compact(d.tokens_total)} tokens · ${d.sessions_count} sessions`}
                    style={{
                      background: d.tokens_total
                        ? `rgba(var(--dash-accent-rgb),${0.22 + Math.min(0.78, d.tokens_total / (peak?.tokens_total || 1))})`
                        : "var(--surface-muted)",
                    }}
                  />
                ))}
              </div>
              <div className="dash-chart-footer">
                <span>{days[0] && shortDate(days[0].date)}</span>
                <span>
                  {peak?.tokens_total
                    ? `Busiest day: ${shortDate(peak.date)} · ${compact(peak.tokens_total)} tokens`
                    : stats.tokens_total > 0
                      ? "No daily history"
                      : "No activity yet"}
                </span>
              </div>
            </section>
            {local && <section className="dash-card dash-recent">
              <div className="dash-card-heading">
                <div>
                  <p className="dash-eyebrow">Session history</p>
                  <h2>Recent sessions</h2>
                </div>
              </div>
              <div className="dash-table-scroll">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Model & tool</th>
                      <th>Last active</th>
                      <th>Tokens</th>
                      <th>API value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.sessions.items.map((s) => (
                      <tr key={`${s.source}:${s.session_id}`}>
                        <td>
                          <strong>
                            {modelName(s.model ?? "Unknown model")}
                          </strong>
                          <small>{s.source}</small>
                        </td>
                        <td>{shortDate(s.ended_at ?? s.started_at)}</td>
                        <td>{compact(s.tokens_total)}</td>
                        <td>{money(s.cost_usd_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!profile.sessions.items.length && (
                <p className="dash-muted">No sessions to show.</p>
              )}
            </section>}
            {!local && <p className="dash-footnote">This profile shares daily totals only. Individual sessions and conversations stay on the owner’s device.</p>}
            {local && profile.shipped && (
              <details className="dash-card dash-recent">
                <summary className="dash-detail-summary">
                  Code contribution details <ChevronDown size={15} />
                </summary>
                <p className="dash-footnote">
                  These are recorded branch contributions and commit references.
                  They do not establish deployment or code quality. {local?'Local code totals cover all time.':'Code totals follow the selected period where available.'}
                </p>
                <div className="dash-code-stats">
                  <div>
                    <span>Session-linked additions</span>
                    <strong>
                      {compact(profile.shipped.produced_loc_total)}
                    </strong>
                    <small>added lines in referenced commits</small>
                  </div>
                  <div>
                    <span>Linked branch contributions</span>
                    <strong>
                      {compact(profile.shipped.produced_shipped_loc_total)}
                    </strong>
                    <small>added lines found on selected branches</small>
                  </div>
                  <div>
                    <span>GitHub contribution</span>
                    <strong>{compact(profile.shipped.loc_total)}</strong>
                    <small>added lines checked on GitHub branches</small>
                  </div>
                </div>
              </details>
            )}
          </>
        )}
      </div>
      {!local && <ProjectFooter />}
    </div>
  );
}
