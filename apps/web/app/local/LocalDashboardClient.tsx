'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  DollarSign,
  GitBranch,
  Github,
  RefreshCw,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import type {
  LocalDiscoveredRepo,
  LocalGithubDeviceStartResponse,
  LocalGithubDeviceStatusResponse,
  LocalOperationRun,
  LocalOperationType,
  LocalScheduleStatus,
  LocalSetupStatus,
  LocalVersionStatus,
  PublishLocalResponse,
} from '@tokensrank/shared';
import { apiFetch } from '../lib/api';
import { LocalShell } from './LocalShell';

type PublishVerificationStatus = 'pending' | 'processing' | 'passed' | 'failed' | 'unavailable';

type LocalSettingsPublishStatus = {
  token_connected: boolean;
  connection_status?: string;
  connection_error?: string | null;
  hosted_api_base: string;
  last_response: PublishLocalResponse | null;
  hosted_status: {
    data?: {
      publish_run?: {
        id?: string;
        verification_status?: PublishVerificationStatus;
        completed_at?: string | null;
        verification_completed_at?: string | null;
      };
      trust?: {
        rank_eligible?: boolean | null;
        leaderboard_hidden_at?: string | null;
        deboost_multiplier?: number | string | null;
      } | null;
    };
    error?: {
      message?: string;
    };
  } | null;
  publish_history: Array<{
    publish_run_id: string;
    sent_at: string;
    verification_status: PublishVerificationStatus | string;
    rank_eligible: boolean | null;
    deboost_multiplier: number | string | null;
  }>;
};

type OperationEnvelope = {
  data: {
    operation?: LocalOperationRun | null;
    operation_id?: string | null;
    status?: string;
    already_running?: boolean;
  };
};

type RepoSelectionResponse = {
  data: {
    repos: LocalDiscoveredRepo[];
    operation?: LocalOperationRun;
  };
};

type Toast = {
  id: string;
  tone: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
};

const ACTIVE_OPERATION_STATUSES = new Set(['queued', 'running']);
const SETTINGS_OPERATION_TYPES: LocalOperationType[] = [
  'discover',
  'pricing_sync',
  'usage_ingest',
  'github_sync',
  'repo_selection',
  'schedule_run',
  'version_check',
  'onboarding_reset',
];

function isActiveOperation(operation: LocalOperationRun | null | undefined): boolean {
  return Boolean(operation && ACTIVE_OPERATION_STATUSES.has(operation.status));
}

function formatNumber(value: number | null | undefined): string {
  return Math.round(value ?? 0).toLocaleString();
}

function formatMoney(value: number | null | undefined): string {
  return `$${Math.round((value ?? 0) * 100) / 100}`;
}

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const diffMs = timestamp - Date.now();
  const absMs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? 'from now' : 'ago';
  if (absMs < 60_000) return diffMs >= 0 ? 'in less than 1m' : 'just now';
  if (absMs < 60 * 60_000) return `${Math.round(absMs / 60_000)}m ${suffix}`;
  if (absMs < 24 * 60 * 60_000) return `${Math.round(absMs / (60 * 60_000))}h ${suffix}`;
  if (absMs < 14 * 24 * 60 * 60_000) return `${Math.round(absMs / (24 * 60 * 60_000))}d ${suffix}`;
  return new Date(value).toLocaleDateString();
}

function statusTone(ok: boolean, warning = false): 'green' | 'amber' | 'red' | 'muted' {
  if (ok) return 'green';
  if (warning) return 'amber';
  return 'muted';
}

function statusClass(tone: 'green' | 'amber' | 'red' | 'muted'): string {
  if (tone === 'green') return 'bg-[var(--accent-soft)] text-black';
  if (tone === 'amber') return 'bg-amber-400 text-black';
  if (tone === 'red') return 'bg-red-400 text-black';
  return 'bg-[var(--surface-muted)] text-[var(--muted)]';
}

function operationToastTitle(operation: LocalOperationRun): string {
  if (operation.status === 'completed') return `${operation.label} complete`;
  if (operation.status === 'failed') return `${operation.label} failed`;
  if (operation.status === 'interrupted') return `${operation.label} interrupted`;
  return operation.label;
}

function operationToastMessage(operation: LocalOperationRun): string {
  if (operation.error) return operation.error;
  if (operation.message) return operation.message;
  return operation.stage.replace(/_/gu, ' ');
}

function branchOptions(repo: LocalDiscoveredRepo, draft: { prod_branch: string }): string[] {
  return Array.from(new Set([
    draft.prod_branch,
    repo.prod_branch,
    repo.default_branch,
    'main',
    ...repo.branches,
  ].filter((value): value is string => Boolean(value?.trim()))));
}

function repoLabel(repo: LocalDiscoveredRepo): string {
  return repo.full_name ?? repo.local_root;
}

function stageLabel(stage: string): string {
  return stage.replace(/_/gu, ' ');
}

function operationSubtitle(operation: LocalOperationRun): string {
  const countText = operation.total && operation.current !== null
    ? ` · ${formatNumber(operation.current)} / ${formatNumber(operation.total)}`
    : '';
  return `${stageLabel(operation.stage)}${countText}`;
}

function shortIdentifier(value: string | null | undefined): string {
  if (!value) return 'none';
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function OperationProgress({ operation }: { operation: LocalOperationRun | null | undefined }) {
  if (!operation || !isActiveOperation(operation)) return null;
  const percent = operation.progress_percent ?? null;
  return (
    <div className="mt-5 rounded-md border border-[var(--accent)]/20 bg-[var(--accent-soft)]/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 font-sans text-xs">
        <span className="uppercase tracking-[0.2em] text-[var(--accent)]">{operation.label}</span>
        <span className="text-[var(--muted)]">{percent === null ? 'running' : `${Math.round(percent)}%`}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div
          className={`h-full rounded-full bg-[var(--accent)] ${percent === null ? 'w-1/3 animate-pulse' : ''}`}
          style={percent === null ? undefined : { width: `${Math.max(4, Math.min(100, percent))}%` }}
        />
      </div>
      <div className="mt-3 font-sans text-xs leading-5 text-[var(--muted)]">
        {operation.message ?? operationSubtitle(operation)}
      </div>
    </div>
  );
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed right-5 top-20 z-50 flex w-[360px] max-w-[calc(100vw-40px)] flex-col gap-3">
      {toasts.map((toast) => {
        const Icon = toast.tone === 'success' ? CheckCircle2 : toast.tone === 'error' ? XCircle : AlertTriangle;
        const toneClass = toast.tone === 'success'
          ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]'
          : toast.tone === 'error'
            ? 'border-red-500/40 bg-red-50 text-red-700'
            : toast.tone === 'warning'
              ? 'border-amber-400/40 bg-amber-50 text-amber-800'
              : 'border-[var(--line)] bg-[var(--surface-muted)] text-[var(--ink)]';
        return (
          <button
            key={toast.id}
            type="button"
            className={`rounded-md border p-4 text-left shadow-sm ${toneClass}`}
            onClick={() => onDismiss(toast.id)}
          >
            <div className="flex gap-3">
              <Icon size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="font-sans text-sm font-semibold">{toast.title}</div>
                <div className="mt-1 font-sans text-xs leading-5 opacity-80">{toast.message}</div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function SectionCard({
  children,
  description,
  eyebrow,
  operation,
  title,
  action,
}: {
  children: React.ReactNode;
  description: string;
  eyebrow: string;
  operation?: LocalOperationRun | null;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <details open={title === 'Automatic updates' ? true : undefined} className="dash-settings-section">
      <summary className="cursor-pointer flex flex-wrap items-start justify-between gap-4 p-6">
        <div>
          <div className="dash-eyebrow">{eyebrow}</div>
          <h2 className="mt-3 text-2xl font-semibold tracking-normal text-[var(--ink)]">{title}</h2>
          <p className="mt-3 max-w-2xl font-sans text-sm leading-6 text-[var(--muted)]">{description}</p>
        </div>
      </summary>
      <div className="p-6">
        {action ? <div className="mb-5 flex flex-wrap gap-3">{action}</div> : null}
        {children}
        <OperationProgress operation={operation} />
      </div>
    </details>
  );
}

function PrimaryButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="dash-button primary"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  disabled,
  href,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  href?: string;
  onClick?: () => void;
}) {
  const className = "dash-button";
  if (href) {
    return <a className={className} href={href}>{children}</a>;
  }
  return (
    <button type="button" className={className} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function MetricCells({
  columns = 'four',
  items,
}: {
  columns?: 'two' | 'four';
  items: Array<{ label: string; value: string; sub?: string }>;
}) {
  const gridClass = columns === 'two'
    ? 'sm:grid-cols-2'
    : 'sm:grid-cols-2 xl:grid-cols-4';

  return (
    <div className={`grid gap-px overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface-muted)] ${gridClass}`}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0 bg-white p-5">
          <div className="font-sans text-xs uppercase tracking-[0.22em] text-[var(--muted)]">{item.label}</div>
          <div className="mt-3 min-w-0 break-words font-sans text-2xl leading-tight text-[var(--ink)] sm:text-3xl">
            {item.value}
          </div>
          {item.sub ? <div className="mt-2 min-w-0 break-words font-sans text-xs leading-5 text-[var(--muted)]">{item.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

function HealthTile({
  icon,
  label,
  sub,
  tone,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  tone: 'green' | 'amber' | 'red' | 'muted';
  value: string;
}) {
  return (
    <div className="min-w-0 border-b border-r border-[var(--line)] p-5 last:border-r-0 md:[&:nth-child(3n)]:border-r-0 xl:[&:nth-child(3n)]:border-r xl:[&:nth-child(6n)]:border-r-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[var(--muted)]">{icon}<span className="font-sans text-xs uppercase tracking-[0.2em]">{label}</span></div>
        <span className={`h-2.5 w-2.5 rounded-full ${tone === 'green' ? 'bg-[var(--accent-soft)]' : tone === 'amber' ? 'bg-amber-400' : tone === 'red' ? 'bg-red-400' : 'bg-slate-600'}`} />
      </div>
      <div className="mt-4 min-w-0 break-words font-sans text-xl leading-tight text-[var(--ink)]">{value}</div>
      <div className="mt-2 min-w-0 break-words font-sans text-xs leading-5 text-[var(--muted)]">{sub}</div>
    </div>
  );
}

export function LocalDashboardClient() {
  const [status, setStatus] = useState<LocalSetupStatus | null>(null);
  const [deviceFlow, setDeviceFlow] = useState<LocalGithubDeviceStartResponse | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<LocalGithubDeviceStatusResponse | null>(null);
  const [repoDrafts, setRepoDrafts] = useState<Record<string, { selected: boolean; prod_branch: string }>>({});
  const [schedule, setSchedule] = useState<LocalScheduleStatus | null>(null);
  const [version, setVersion] = useState<LocalVersionStatus | null>(null);
  const [publishStatus, setPublishStatus] = useState<LocalSettingsPublishStatus | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const operationStateRef = useRef<Map<string, string>>(new Map());

  function addToast(toast: Omit<Toast, 'id'>) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [{ ...toast, id }, ...current].slice(0, 4));
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 4500);
  }

  async function refresh() {
    const next = await apiFetch<LocalSetupStatus>('/local/setup/status', { cache: 'no-store' });
    setStatus(next);
    return next;
  }

  async function refreshSchedule() {
    const next = await apiFetch<LocalScheduleStatus>('/local/schedule/status', { cache: 'no-store' });
    setSchedule(next);
    return next;
  }

  async function refreshVersion() {
    const next = await apiFetch<LocalVersionStatus>('/local/version', { cache: 'no-store' });
    setVersion(next);
    return next;
  }

  async function refreshPublishStatus() {
    const response = await apiFetch<{ data: LocalSettingsPublishStatus }>('/local/publish/status', { cache: 'no-store' });
    setPublishStatus(response.data);
    return response.data;
  }

  async function refreshAll() {
    await Promise.all([refresh(), refreshSchedule(), refreshVersion(), refreshPublishStatus()]);
  }

  async function startOperationAction(label: string, path: string, init?: RequestInit) {
    try {
      const response = await apiFetch<OperationEnvelope>(path, {
        method: init?.method ?? 'POST',
        body: init?.body,
      });
      const operation = response.data.operation;
      addToast({
        tone: response.data.already_running ? 'warning' : 'info',
        title: response.data.already_running ? `${label} already running` : `${label} started`,
        message: operation?.message ?? 'Status will update here while the local API works.',
      });
      await refreshAll();
    } catch (error) {
      addToast({
        tone: 'error',
        title: `${label} failed`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function updateSchedule(patch: Partial<LocalScheduleStatus['config']>) {
    try {
      const next = await apiFetch<LocalScheduleStatus>('/local/schedule/config', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setSchedule(next);
      addToast({
        tone: 'success',
        title: 'Schedule updated',
        message: next.config.enabled ? `Next run ${formatRelativeTime(next.next_run_at)}.` : 'Automatic updates are disabled.',
      });
    } catch (error) {
      addToast({
        tone: 'error',
        title: 'Schedule update failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function saveRepoSelection() {
    try {
      const response = await apiFetch<RepoSelectionResponse>('/local/repos/selection', {
        method: 'POST',
        body: JSON.stringify({
          repos: Object.entries(repoDrafts).map(([id, draft]) => ({
            id,
            selected: draft.selected,
            prod_branch: draft.prod_branch.trim() || null,
          })),
        }),
      });
      addToast({
        tone: 'success',
        title: 'Repos saved',
        message: response.data.operation?.message ?? 'Production branch selection saved locally.',
      });
      await refreshAll();
    } catch (error) {
      addToast({
        tone: 'error',
        title: 'Could not save repos',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function startGithubDeviceFlow() {
    try {
      const response = await apiFetch<LocalGithubDeviceStartResponse>('/local/auth/github/device/start', {
        method: 'POST',
      });
      setDeviceFlow(response);
      setDeviceStatus({ status: 'pending', message: null, identity: null });
      addToast({
        tone: 'info',
        title: 'GitHub device flow started',
        message: 'Approve the code in GitHub. This page will poll locally.',
      });
    } catch (error) {
      addToast({
        tone: 'error',
        title: 'GitHub connection failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function pollGithubDeviceFlow() {
    const response = await apiFetch<LocalGithubDeviceStatusResponse>('/local/auth/github/device/status', {
      cache: 'no-store',
    });
    setDeviceStatus(response);
    if (response.status === 'authorized') {
      setDeviceFlow(null);
      addToast({
        tone: 'success',
        title: 'GitHub connected',
        message: response.identity ? `Connected @${response.identity.login} locally.` : 'GitHub identity connected locally.',
      });
      await refreshAll();
    } else if (response.status === 'error' || response.status === 'expired') {
      addToast({
        tone: 'error',
        title: 'GitHub device flow stopped',
        message: response.message ?? 'Start a new GitHub connection.',
      });
    }
  }

  useEffect(() => {
    refreshAll().catch((error) => {
      addToast({
        tone: 'error',
        title: 'Local status failed',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  useEffect(() => {
    if (!status) return;
    setRepoDrafts((current) => {
      const next: Record<string, { selected: boolean; prod_branch: string }> = {};
      for (const repo of status.repos) {
        next[repo.id] = current[repo.id] ?? {
          selected: repo.selected,
          prod_branch: repo.prod_branch ?? repo.default_branch ?? 'main',
        };
      }
      return next;
    });
  }, [status]);

  useEffect(() => {
    if (!deviceFlow || deviceStatus?.status !== 'pending') return;
    const nextPollMs = deviceStatus?.next_poll_at
      ? Math.max(0, Date.parse(deviceStatus.next_poll_at) - Date.now())
      : Math.max(deviceStatus?.poll_interval_seconds ?? deviceFlow.interval, 5) * 1000;
    const timeout = window.setTimeout(() => {
      pollGithubDeviceFlow().catch((error) => {
        addToast({
          tone: 'error',
          title: 'GitHub status failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, nextPollMs);
    return () => window.clearTimeout(timeout);
  }, [deviceFlow, deviceStatus?.next_poll_at, deviceStatus?.poll_interval_seconds, deviceStatus?.status]);

  const operations = status?.operations ?? [];
  const hasActiveOperations = operations.some(isActiveOperation) || schedule?.running === true;

  useEffect(() => {
    if (!hasActiveOperations) return;
    const interval = window.setInterval(() => {
      refreshAll().catch((error) => {
        addToast({
          tone: 'error',
          title: 'Status refresh failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, 2000);
    return () => window.clearInterval(interval);
  }, [hasActiveOperations]);

  useEffect(() => {
    for (const operation of operations) {
      const previous = operationStateRef.current.get(operation.operation_id);
      operationStateRef.current.set(operation.operation_id, operation.status);
      if (!previous || previous === operation.status) continue;
      if (operation.status === 'completed') {
        addToast({
          tone: 'success',
          title: operationToastTitle(operation),
          message: operationToastMessage(operation),
        });
      } else if (operation.status === 'failed' || operation.status === 'interrupted') {
        addToast({
          tone: 'error',
          title: operationToastTitle(operation),
          message: operationToastMessage(operation),
        });
      }
    }
  }, [operations]);

  const operationByType = useMemo(() => {
    const map = new Map<LocalOperationType, LocalOperationRun>();
    for (const type of SETTINGS_OPERATION_TYPES) {
      const operation = operations.find((item) => item.type === type);
      if (operation) map.set(type, operation);
    }
    return map;
  }, [operations]);

  const discoveredRepos = status?.repos ?? [];
  const publicRepos = discoveredRepos.filter((repo) => repo.full_name && repo.matched);
  const localOnlyRepos = discoveredRepos.filter((repo) => !repo.full_name || !repo.matched);
  const selectedDraftCount = Object.values(repoDrafts).filter((repo) => repo.selected).length;
  const matchedRepos = status?.repos.filter((repo) => repo.matched).length ?? 0;
  const selectedRepos = status?.repos.filter((repo) => repo.selected).length ?? 0;
  const sourceFiles = status?.usage_sources.reduce((total, source) => total + source.file_count, 0) ?? 0;
  const githubReady = Boolean(status?.github);
  const pricingReady = (status?.pricing.row_count ?? 0) > 0;
  const verification = status?.github_verification;
  const scheduleConfig = schedule?.config ?? { enabled: false, interval_minutes: 60, auto_publish: false };
  const publishRun = publishStatus?.hosted_status?.data?.publish_run;
  const latestPublish = publishStatus?.publish_history[0] ?? null;
  const latestPublishStatus = publishRun?.verification_status
    ?? latestPublish?.verification_status
    ?? publishStatus?.last_response?.data.verification_status;
  const devicePollBlocked = Boolean(deviceStatus?.next_poll_at && Date.parse(deviceStatus.next_poll_at) > Date.now());

  return (
    <LocalShell>
      <ToastStack
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
      <div className="dash-content dash-settings-content flex w-full flex-col gap-7">
        <section className="flex flex-wrap items-start justify-between gap-6 border-b border-[var(--line)] pb-8">
          <div>
            <div className="font-sans text-xs uppercase tracking-[0.15em] text-[var(--accent)]">Local settings</div>
            <h1 className="mt-3 text-4xl font-semibold tracking-normal text-[var(--ink)]">Settings</h1>
            <p className="mt-3 max-w-2xl font-sans text-sm leading-6 text-[var(--muted)]">
              Choose when your usage updates. Manage connected tools and explore advanced settings when you need them.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <SecondaryButton href="/local/profile">Open profile</SecondaryButton>
            <PrimaryButton onClick={() => window.location.assign('/local/publish')}>
              <UploadCloud size={16} aria-hidden="true" />
              Post to Leaderboard
            </PrimaryButton>
          </div>
        </section>

        <SectionCard
          eyebrow="Automation"
          title="Automatic updates"
          description="Refreshes when the local app opens, then at your chosen interval while it stays running. After sleep, the next refresh catches up."
          operation={operationByType.get('schedule_run')}
          action={(
            <PrimaryButton
              disabled={isActiveOperation(operationByType.get('schedule_run'))}
              onClick={() => startOperationAction('Run update now', '/local/schedule/run', { body: JSON.stringify({}) })}
            >
              <RefreshCw size={16} aria-hidden="true" />
              Run update now
            </PrimaryButton>
          )}
        >
          <div className="dash-settings-summary" role="status"><span>{!schedule ? 'Checking refresh settings…' : schedule.running ? 'An update is running in the background.' : scheduleConfig.enabled ? `Automatic updates are on, every ${scheduleConfig.interval_minutes} minutes.` : 'Automatic updates are paused. You can still refresh manually.'}</span><small>{schedule?.usage_updated_at ? `Usage last checked ${formatRelativeTime(schedule.usage_updated_at)}` : schedule?.last_finished_at ? `Last update ${formatRelativeTime(schedule.last_finished_at)}` : 'Your first refresh will appear here.'}</small></div>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <label className="flex items-center gap-3 font-sans text-sm text-[var(--muted)]">
              <input
                disabled={!schedule}
                checked={scheduleConfig.enabled}
                className="h-4 w-4 accent-[var(--accent)]"
                type="checkbox"
                onChange={(event) => updateSchedule({ enabled: event.target.checked })}
              />
              Enable automatic updates
            </label>
            <label className="flex items-center gap-3 font-sans text-sm text-[var(--muted)]">
              Every
              <select
                disabled={!schedule}
                value={scheduleConfig.interval_minutes}
                className="w-24 rounded-md border border-[var(--line)] bg-[var(--surface-muted)] px-3 py-2 font-sans text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]/60"
                onChange={(event) => updateSchedule({ interval_minutes: Number.parseInt(event.target.value, 10) || 60 })}
              >
                {[15, 30, 60, 120, 240, 720, 1440].map((minutes) => (
                  <option key={minutes} value={minutes}>{minutes}</option>
                ))}
              </select>
              minutes
            </label>
            <p className="text-sm text-[var(--muted)]">Refreshes stay on this device. Publishing always requires reviewing and confirming a sharing receipt.</p>
          </div>
          {schedule?.last_error ? (
            <div className="mt-5 rounded-md border border-red-500/30 bg-red-500/10 p-4 font-sans text-sm text-red-700">
              {schedule.last_error}
            </div>
          ) : null}
        </SectionCard>

        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard
            eyebrow="GitHub"
            title="GitHub identity"
            description="Used locally to match repos and verify shipped code. Raw usage files stay on this machine."
            action={(
              <PrimaryButton onClick={startGithubDeviceFlow}>
                <Github size={16} aria-hidden="true" />
                {githubReady ? 'Reconnect GitHub' : 'Connect GitHub'}
              </PrimaryButton>
            )}
          >
            <MetricCells columns="two" items={[
              { label: 'Account', value: githubReady ? `@${status?.github?.login}` : 'none', sub: githubReady ? 'connected locally' : 'not connected' },
              { label: 'Emails', value: formatNumber(status?.github?.verified_emails.length), sub: 'verified by GitHub' },
              { label: 'Connected', value: formatRelativeTime(status?.github?.connected_at), sub: 'local token stored' },
              { label: 'Data upload', value: 'none', sub: 'until you post' },
            ]} />
            {deviceFlow ? (
              <div className="mt-5 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-soft)]/5 p-5">
                <div className="font-sans text-xs uppercase tracking-[0.12em] text-[var(--accent)]">GitHub device flow</div>
                <div className="mt-4 flex flex-wrap items-center gap-4">
                  <code className="rounded-md border border-[var(--line)] bg-[var(--accent-soft)] px-4 py-3 font-sans text-2xl text-[var(--ink)]">
                    {deviceFlow.user_code}
                  </code>
                  <SecondaryButton href={deviceFlow.verification_uri}>Open GitHub</SecondaryButton>
                  <SecondaryButton disabled={devicePollBlocked} onClick={() => pollGithubDeviceFlow()}>
                    Check status
                  </SecondaryButton>
                </div>
                <p className="mt-3 font-sans text-sm text-[var(--muted)]">
                  {deviceStatus?.message ?? 'Approve this code in GitHub. The page polls locally and updates automatically.'}
                </p>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            eyebrow="Usage data"
            title="Import usage files"
            description="Reads Claude, Codex, and OpenCode activity on this device. Unchanged files are skipped."
            operation={operationByType.get('usage_ingest')}
            action={(
              <PrimaryButton
                disabled={isActiveOperation(operationByType.get('usage_ingest')) || isActiveOperation(operationByType.get('schedule_run'))}
                onClick={() => startOperationAction('Import usage', '/local/ingest/run')}
              >
                <RefreshCw size={16} aria-hidden="true" />
                Import usage
              </PrimaryButton>
            )}
          >
            <MetricCells columns="two" items={[
              { label: 'Usage files', value: formatNumber(sourceFiles), sub: `${status?.usage_sources.length ?? 0} roots` },
              { label: 'Events', value: formatNumber(status?.ingestion.events_inserted), sub: `${formatNumber(status?.ingestion.events_deduped)} deduped` },
              { label: 'Status', value: status?.ingestion.status ?? 'idle', sub: `run ${shortIdentifier(status?.ingestion.run_id)}` },
              { label: 'Last import', value: formatRelativeTime(status?.ingestion.finished_at), sub: `started ${formatRelativeTime(status?.ingestion.started_at)}` },
            ]} />
            <details className="mt-5">
              <summary className="cursor-pointer font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Usage roots</summary>
              <div className="mt-4 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
                {(status?.usage_sources ?? []).map((source) => (
                  <div key={source.root_path} className="grid gap-2 p-4 font-sans text-sm md:grid-cols-[minmax(0,1fr)_90px]">
                    <span className="truncate text-[var(--muted)]">{source.root_path}</span>
                    <span className={source.readable ? 'text-right text-[var(--accent)]' : 'text-right text-[var(--muted)]'}>
                      {formatNumber(source.file_count)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </SectionCard>
        </div>

        <SectionCard
          eyebrow="Repos"
          title="Repos and production branches"
          description="Pick the GitHub repos that count toward shipped-code stats. The selected branch is treated as production."
          operation={operationByType.get('repo_selection')}
          action={(
            <PrimaryButton
              disabled={isActiveOperation(operationByType.get('repo_selection')) || discoveredRepos.length === 0}
              onClick={saveRepoSelection}
            >
              Save repos
            </PrimaryButton>
          )}
        >
          <div className="flex flex-wrap gap-3">
            <SecondaryButton
              disabled={isActiveOperation(operationByType.get('discover'))}
              onClick={() => startOperationAction('Discover folders', '/local/discovery/run')}
            >
              Discover folders
            </SecondaryButton>
          </div>
          <OperationProgress operation={operationByType.get('discover')} />
          <div className="mt-5 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
            {publicRepos.length === 0 ? (
              <div className="p-5 font-sans text-sm text-[var(--muted)]">Run discovery to find local GitHub repositories.</div>
            ) : publicRepos.map((repo) => {
              const draft = repoDrafts[repo.id] ?? {
                selected: repo.selected,
                prod_branch: repo.prod_branch ?? repo.default_branch ?? 'main',
              };
              const repoTone = repo.remote_sync_error ? 'red' : repo.last_remote_sync_at ? 'green' : 'amber';
              return (
                <div key={repo.id} className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_220px_120px] md:items-center">
                  <label className="flex min-w-0 items-start gap-3">
                    <input
                      checked={draft.selected}
                      className="mt-1 h-4 w-4 accent-[var(--accent)]"
                      type="checkbox"
                      onChange={(event) => setRepoDrafts((current) => ({
                        ...current,
                        [repo.id]: { ...draft, selected: event.target.checked },
                      }))}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-sans text-sm text-[var(--ink)]">{repoLabel(repo)}</span>
                      <span className="mt-1 block truncate font-sans text-xs text-[var(--muted)]">{repo.local_root}</span>
                      <span className={`mt-2 inline-flex rounded px-2 py-1 font-sans text-[11px] ${statusClass(repoTone)}`}>
                        {repo.remote_sync_error ? 'sync failed' : repo.last_remote_sync_at ? `synced ${formatRelativeTime(repo.last_remote_sync_at)}` : 'needs sync'}
                      </span>
                      {repo.worktree_count > 0 ? (
                        <span className="ml-2 mt-2 inline-flex rounded border border-[var(--line)] px-2 py-1 font-sans text-[11px] text-[var(--muted)]">
                          {repo.worktree_count} worktree{repo.worktree_count === 1 ? '' : 's'} folded in
                        </span>
                      ) : null}
                      {repo.remote_sync_error ? (
                        <span className="mt-2 block font-sans text-xs leading-5 text-red-700">{repo.remote_sync_error}</span>
                      ) : null}
                    </span>
                  </label>
                  <select
                    value={draft.prod_branch}
                    className="rounded-md border border-[var(--line)] bg-[var(--surface-muted)] px-3 py-2 font-sans text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]/60"
                    onChange={(event) => setRepoDrafts((current) => ({
                      ...current,
                      [repo.id]: { ...draft, prod_branch: event.target.value },
                    }))}
                  >
                    {branchOptions(repo, draft).map((branch) => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                  <div className="font-sans text-xs text-[var(--muted)] md:text-right">
                    {draft.selected ? 'selected' : 'ignored'}
                  </div>
                </div>
              );
            })}
          </div>
          {localOnlyRepos.length > 0 ? (
            <details className="mt-5">
              <summary className="cursor-pointer font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                Ignored local-only repos ({localOnlyRepos.length})
              </summary>
              <div className="mt-4 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
                {localOnlyRepos.slice(0, 40).map((repo) => (
                  <div key={repo.id} className="p-4">
                    <div className="truncate font-sans text-sm text-[var(--muted)]">{repo.local_root}</div>
                    <div className="mt-1 font-sans text-xs text-[var(--muted)]">local-only · not used for public rank</div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </SectionCard>

        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard
            eyebrow="Shipped code"
            title="Sync production code"
            description="Fetches production-branch commits from GitHub and matches them to direct AI commit SHAs found locally."
            operation={operationByType.get('github_sync')}
            action={(
              <PrimaryButton
                disabled={selectedDraftCount === 0 || isActiveOperation(operationByType.get('github_sync')) || isActiveOperation(operationByType.get('schedule_run'))}
                onClick={() => startOperationAction('Sync shipped code', '/local/github/sync')}
              >
                <RefreshCw size={16} aria-hidden="true" />
                Sync shipped code
              </PrimaryButton>
            )}
          >
            <MetricCells columns="two" items={[
              { label: 'GitHub prod LOC', value: formatNumber(verification?.github_total_loc), sub: `${formatNumber(verification?.github_total_commits)} commits` },
              { label: 'AI-coded shipped LOC', value: formatNumber(verification?.ai_linked_loc), sub: 'direct SHA subset' },
              { label: 'Repos verified', value: formatNumber(verification?.verified_repo_count), sub: `${selectedRepos} selected` },
              { label: 'Last synced', value: formatRelativeTime(verification?.last_verified_at), sub: 'remote prod branch' },
            ]} />
            {verification?.invariant_violations.length ? (
              <div className="mt-5 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 font-sans text-sm text-amber-800">
                {verification.invariant_violations[0]}
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            eyebrow="Pricing"
            title="Model pricing"
            description="Reference prices for estimated API value. Usage imports keep model costs and counters together."
            operation={operationByType.get('pricing_sync')}
            action={(
              <PrimaryButton
                disabled={isActiveOperation(operationByType.get('pricing_sync'))}
                onClick={() => startOperationAction('Sync pricing', '/local/reference/pricing/sync')}
              >
                <RefreshCw size={16} aria-hidden="true" />
                Sync pricing
              </PrimaryButton>
            )}
          >
            <MetricCells columns="two" items={[
              { label: 'Rows', value: formatNumber(status?.pricing.row_count), sub: 'local model pricing' },
              { label: 'Source', value: status?.pricing.source ?? 'empty', sub: 'reference catalog' },
              { label: 'Fetched', value: formatRelativeTime(status?.pricing.fetched_at), sub: 'last successful sync' },
              { label: 'Profile cost', value: formatMoney(status?.pricing.row_count ? undefined : 0), sub: status?.pricing.last_error ?? 'shown on profile' },
            ]} />
            {status?.pricing.last_error ? (
              <div className="mt-5 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 font-sans text-sm text-amber-800">
                {status.pricing.last_error}
              </div>
            ) : null}
          </SectionCard>
        </div>



        <SectionCard
          eyebrow="Leaderboard"
          title="Public leaderboard"
          description="Posting is optional. It sends a verified summary, then hosted checks run in the background before rank eligibility."
          action={<PrimaryButton onClick={() => window.location.assign('/local/publish')}><UploadCloud size={16} aria-hidden="true" />Post to Leaderboard</PrimaryButton>}
        >
          <MetricCells items={[
            { label: 'Hosted link', value: publishStatus?.connection_status ?? 'not connected', sub: publishStatus?.connection_error ?? publishStatus?.hosted_api_base ?? 'not loaded' },
            { label: 'Last post', value: latestPublish ? formatRelativeTime(latestPublish.sent_at) : 'none', sub: latestPublish?.publish_run_id ?? 'no run yet' },
            { label: 'Hosted check', value: latestPublishStatus ? latestPublishStatus.replace(/_/gu, ' ') : 'not posted', sub: publishRun?.id ?? 'background verification' },
            { label: 'Rank', value: !publishStatus?.hosted_status?.data?.trust ? 'not verified' : publishStatus.hosted_status.data.trust.rank_eligible ? 'eligible' : 'hidden', sub: 'after verification' },
          ]} />
          {publishStatus?.hosted_status?.error?.message ? (
            <div className="mt-5 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 font-sans text-sm text-amber-800">
              {publishStatus.hosted_status.error.message}
            </div>
          ) : null}
        </SectionCard>

        <details className="dash-settings-section">
          <summary className="cursor-pointer p-6 font-sans text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
            Local diagnostics
          </summary>
          <div className="border-t border-[var(--line)] p-6">
            <div className="grid gap-3 font-sans text-sm">
              {[
                ['Data directory', status?.data_dir ?? 'loading'],
                ['SQLite database', status?.database_path ?? 'loading'],
                ['Config file', status?.config_path ?? 'loading'],
                ['Logs directory', status?.logs_path ?? 'loading'],
              ].map(([label, value]) => (
                <div key={label} className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)] md:items-center">
                  <span className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">{label}</span>
                  <code className="truncate rounded-md border border-[var(--line)] bg-[var(--surface-muted)] px-3 py-2 text-[var(--muted)]">{value}</code>
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <SecondaryButton onClick={() => startOperationAction('Check updates', '/local/version/check')}>Check updates</SecondaryButton>
              <SecondaryButton onClick={() => startOperationAction('Reset onboarding', '/local/onboarding/reset')}>Reset onboarding</SecondaryButton>
            </div>
            <MetricCells items={[
              { label: 'Package', value: version?.package_name ?? 'tokensrank-local', sub: 'local CLI package' },
              { label: 'Current', value: version?.current_version ?? 'unknown', sub: `checked ${formatRelativeTime(version?.checked_at)}` },
              { label: 'Latest', value: version?.latest_version ?? 'unknown', sub: version?.source ?? 'unknown' },
              { label: 'Update', value: version?.update_available ? 'available' : 'current', sub: version?.last_error ?? 'manual check' },
            ]} />
            <OperationProgress operation={operationByType.get('version_check')} />
            <OperationProgress operation={operationByType.get('onboarding_reset')} />
          </div>
        </details>
      </div>
    </LocalShell>
  );
}
