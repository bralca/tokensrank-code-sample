'use client';

import { useEffect, useRef, useState } from 'react';
import type { LocalSetupStatus } from '@tokensrank/shared';
import { apiFetch } from '../../lib/api';

export function CodeRefresh({ onReady, errorMessage }: { onReady: () => void; errorMessage: string }) {
  const [setup, setSetup] = useState<LocalSetupStatus | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await apiFetch<LocalSetupStatus>('/local/setup/status', { cache: 'no-store' });
        if (cancelled) return;
        setSetup(value);
        const job = value.operations.find((item) => item.operation_id === jobId);
        if (job && !['queued', 'running'].includes(job.status)) {
          setJobId(null);
          if (job.status === 'completed' && !job.error) ready.current();
          else setError(job.error ?? 'GitHub refresh was interrupted. Please try again.');
          return;
        }
      } catch { if (!cancelled) setError('Could not check the GitHub refresh. Checking again shortly.'); }
      if (!cancelled) timer = setTimeout(poll, 4_000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId]);
  const operation = setup?.operations.find((item) => ['queued', 'running'].includes(item.status) && ['github_sync', 'schedule_run'].includes(item.type));
  const selected = setup?.repos.filter((repo) => repo.selected) ?? [];
  const syncError = error || selected.find((repo) => repo.remote_sync_error)?.remote_sync_error || errorMessage;
  const retryAt = syncError?.match(/Try again after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
  const paused = Boolean(retryAt && Date.parse(retryAt) > Date.now());
  const message = syncError?.replace(/^.*?\[github\] (?=GitHub refresh paused)/, '').replace(/\[(publish|github)\] /g, '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (date) => new Date(date).toLocaleString());
  return <div className="publish-code-refresh">
    <h3>{operation ? 'Refreshing code totals privately' : paused ? 'GitHub refresh is paused' : 'Prepare your code totals'}</h3>
    <p>GitHub verifies the selected repositories before they can be included. You can turn off code contributions above to share usage totals now.</p>
    {operation && <p role="status">{operation.message}</p>}
    {message && <p role="alert" className="publish-error">{message}</p>}
    {setup && (!setup.github || selected.length === 0) ? <p><a href="/local/settings">Choose repositories in local settings</a> to enable this optional part.</p> : <div className="publish-actions">
      <button className="dash-button" disabled={!setup || starting || Boolean(operation) || Boolean(jobId) || paused} onClick={async () => {
        setStarting(true); setError('');
        try {
          const result = await apiFetch<{ data: { operation_id: string } }>('/local/github/sync', { method: 'POST' });
          setJobId(result.data.operation_id);
        } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not start the GitHub refresh.'); }
        finally { setStarting(false); }
      }}>{operation || jobId || starting ? 'Refreshing…' : 'Refresh GitHub totals'}</button>
      <button className="dash-text-button" disabled={!setup || Boolean(operation) || Boolean(jobId)} onClick={onReady}>Review updated receipt</button>
    </div>}
  </div>;
}
