'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, FileCheck2, FolderSearch, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import type { LocalPublishPayload, LocalScheduleStatus, LocalSetupStatus, ProfileResponse, PublishLocalResponse } from '@tokensrank/shared';
import { apiFetch } from '../../lib/api';
import { Brand } from '../../components/dashboard/Brand';
import { ConnectAccount } from './ConnectAccount';
import { CodeRefresh } from './CodeRefresh';

type Run = { id?: string; verification_status?: 'pending' | 'processing' | 'passed' | 'failed' | 'unavailable'; publication_ready?: boolean; error?: string | null; verification_started_at?: string | null; verification_attempt_count?: number };
type Status = { token_connected: boolean; connection_status: string; connection_error?: string | null; hosted_api_base: string; hosted_dashboard_url?: string; public_profile_url?: string | null; last_response?: PublishLocalResponse | null; hosted_status?: { data?: { publish_run?: Run } } | null };
type Receipt = { receipt_id: string; expires_at: string; byte_size: number; payload: LocalPublishPayload; public_profile_url?: string | null; destination: string };
const steps = ['Calculate privately', 'Connect account', 'Review receipt', 'Publish'];
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);

export function LocalPublishClient() {
  const [step, setStep] = useState(0);
  const [schedule, setSchedule] = useState<LocalScheduleStatus | null>(null);
  const [setup, setSetup] = useState<LocalSetupStatus | null>(null);
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [includeCode, setIncludeCode] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [submitted, setSubmitted] = useState<PublishLocalResponse | null>(null);
  const initialized = useRef(false);
  const refreshStatus = useCallback(async () => {
    const response = await apiFetch<{ data: Status }>('/local/publish/status', { cache: 'no-store' });
    setStatus(response.data); return response.data;
  }, []);
  const refreshSetup = useCallback(async () => {
    const [data, nextSchedule] = await Promise.all([
      apiFetch<LocalSetupStatus>('/local/setup/status', { cache: 'no-store' }),
      apiFetch<LocalScheduleStatus>('/local/schedule/status', { cache: 'no-store' }).catch(() => null),
    ]);
    setSchedule(nextSchedule);
    setSetup(data);
    if (data.profile_ready) setProfile(await apiFetch<ProfileResponse>('/api/profile/local?window=all', { cache: 'no-store' }));
  }, []);
  useEffect(() => {
    void Promise.all([refreshSetup(), refreshStatus().then((value) => {
      if (!initialized.current) {
        initialized.current = true;
        const run = value.hosted_status?.data?.publish_run;
        if (run && (['pending', 'processing'].includes(run.verification_status ?? '') || (run.verification_status === 'passed' && !run.publication_ready))) setStep(3);
      }
    })]).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not reach the local app.'));
  }, [refreshSetup, refreshStatus]);
  const operation = setup?.operations.find((item) => ['queued', 'running'].includes(item.status) && (item.type === 'usage_ingest' || (item.type === 'schedule_run' && !['syncing_pricing', 'syncing_github', 'rebuilding_links', 'completed'].includes(item.stage))));
  const reading = Boolean(operation || setup?.ingestion.status === 'running');
  const usageReady = Boolean(setup?.profile_ready && schedule?.usage_updated_at && (!operation || Date.parse(schedule.usage_updated_at) >= Date.parse(operation.started_at)));
  const waitingForUsage = reading && !usageReady;
  useEffect(() => {
    if (step !== 0) return;
    const timer = setInterval(() => void refreshSetup().catch(() => {}), 4_000);
    return () => clearInterval(timer);
  }, [step, refreshSetup]);
  const run = status?.hosted_status?.data?.publish_run;
  const verification = run?.verification_status ?? submitted?.data.verification_status ?? status?.last_response?.data.verification_status;
  const ready = run?.publication_ready === true;
  const failed = verification === 'failed' || verification === 'unavailable';
  const pending = ['pending', 'processing'].includes(verification ?? '') || (verification === 'passed' && !ready);
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refreshStatus(); if (!cancelled) setError(''); }
      catch { if (!cancelled) setError('Could not check progress. Your summary may still be processing; checking again shortly.'); }
      if (!cancelled) timer = setTimeout(poll, 3_000);
    };
    timer = setTimeout(poll, 3_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pending, refreshStatus]);
  useEffect(() => {
    if (step !== 2) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000); return () => clearInterval(timer);
  }, [step]);
  const expired = Boolean(receipt && Date.parse(receipt.expires_at) <= now);

  async function calculate() {
    setBusy(true); setError('');
    try { await apiFetch('/local/discovery', { cache: 'no-store' }); await apiFetch('/local/ingest/run', { method: 'POST' }); await refreshSetup(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not read your usage.'); }
    finally { setBusy(false); }
  }
  async function prepareReceipt(code = includeCode) {
    setBusy(true); setError(''); setConfirmed(false); setReceipt(null);
    try {
      const response = await apiFetch<{ data: Receipt }>('/local/publish/receipt', { method: 'POST', body: JSON.stringify({ include_code: code }) });
      setReceipt(response.data); setNow(Date.now()); setStep(2);
    } catch (reason) { setStep(2); setError(reason instanceof Error ? reason.message : 'Could not prepare your receipt.'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError(''); setConfirmed(false); setReceipt(null); setIncludeCode(false);
    try { await apiFetch('/local/publish/disconnect', { method: 'POST' }); await refreshStatus(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not disconnect your account.'); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!receipt || !confirmed || expired) return;
    setBusy(true); setError(''); setStep(3); setSubmitted(null);
    // A previous run must not masquerade as this upload's completion.
    setStatus((current) => current ? { ...current, hosted_status: null, last_response: null } : current);
    try {
      const response = await apiFetch<PublishLocalResponse>('/local/publish/send', { method: 'POST', body: JSON.stringify({ receipt_id: receipt.receipt_id, confirmed: true }) });
      setSubmitted(response); await refreshStatus();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not confirm publication. Check the status before trying again.'); }
    finally { setBusy(false); setConfirmed(false); }
  }
  const files = setup?.usage_sources.reduce((sum, source) => sum + (source.readable ? source.file_count : 0), 0) ?? 0;
  const publicUrl = status?.hosted_dashboard_url ?? 'https://tokensrank.ai/me';
  const handle = status?.public_profile_url ? decodeURIComponent(new URL(status.public_profile_url).pathname.split('/').pop() ?? '') : '';

  return <main className="dashboard publish-wizard">
    <header className="publish-header"><Brand href="/local/profile" /><span><ShieldCheck size={15} /> On your device</span><a href="/local/profile">Back to dashboard</a></header>
    <div className="publish-container">
      <ol className="publish-steps" aria-label="Publishing steps">{steps.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined} className={index < step ? 'done' : ''}><span>{index < step ? <Check size={14} /> : index + 1}</span>{label}</li>)}</ol>
      {step === 0 && <section className="publish-panel">
        <p className="dash-eyebrow">01 / ON YOUR COMPUTER</p><h1>Your history stays here.</h1>
        <p className="publish-lead">TokensRank reads your local usage files and turns them into totals. You can use the private dashboard without publishing anything.</p>
        <div className="publish-boundary"><div><FolderSearch size={23} /><h3>Read locally</h3><p>Claude, Codex and OpenCode usage files already on your computer.</p></div><ArrowRight size={18} /><div><LockKeyhole size={23} /><h3>Calculate privately</h3><p>Count tokens and sessions, group models and estimate API value on this device.</p></div><ArrowRight size={18} /><div><FileCheck2 size={23} /><h3>Prepare a receipt</h3><p>Only the summary you review and confirm is sent to the leaderboard.</p></div></div>
        <div className="publish-local-result" role="status"><span className="publish-icon">{reading ? <RefreshCw className="dash-spin" size={22} /> : <Check size={22} />}</span><div><h2>{!setup ? 'Checking your local app' : waitingForUsage ? 'Calculating on your device' : setup?.profile_ready ? 'Your local numbers are ready' : 'Find your usage files'}</h2><p>{!setup ? 'Loading discovery and calculation status…' : reading ? usageReady ? 'Usage totals are ready. Private code analysis is continuing in the background; you can continue.' : operation?.message ?? 'Reading usage files…' : `${files.toLocaleString()} readable files found. Nothing has been published by this step.`}</p>{reading && operation && <progress aria-label="Local calculation progress" max={100} value={operation.progress_percent ?? 0} />}</div></div>
        {profile && <div className="publish-highlights"><div><small>Tokens</small><strong>{compact(profile.headline.tokens_total)}</strong></div><div><small>{profile.evidence?.usage?.sources.some(s=>s.unpriced_models.length>0)?'Partial API value':'API value'}</small><strong>{money(profile.headline.cost_usd_total)}</strong></div><div><small>Sessions</small><strong>{profile.at_glance.sessions_count.toLocaleString()}</strong></div></div>}
        <p className="publish-private-note"><LockKeyhole size={17} /> Prompts, conversations, commands, file contents and individual session history stay on this computer.</p>
        <div className="publish-actions"><button className="dash-button primary" disabled={busy || waitingForUsage || !setup?.profile_ready} onClick={() => { setError(''); setStep(1); }}>Continue <ArrowRight size={16} /></button><button className="dash-button" disabled={busy || reading || !setup} onClick={() => void calculate()}>{reading ? 'Calculating…' : setup?.profile_ready ? 'Refresh local numbers' : 'Read my usage'}</button></div>
        <p className="publish-footnote">Scheduled refreshes update your private dashboard. Each public update requires a new receipt and your confirmation.</p>
      </section>}
      {step === 1 && <section className="publish-panel"><p className="dash-eyebrow">02 / YOUR PUBLIC ACCOUNT</p>
        {status?.token_connected ? <div className="publish-connect"><span className="publish-icon"><Check size={26} /></span><h1>Connected as @{handle || 'your account'}</h1><p>Your identity is connected. Your usage is still private until you confirm the receipt.</p><button className="dash-button primary" disabled={busy} onClick={() => void prepareReceipt()}>Review what will be shared <ArrowRight size={16} /></button><details className="publish-advanced"><summary>Use a different account</summary><button className="dash-button" disabled={busy} onClick={() => void disconnect()}>Disconnect this account</button></details></div>
          : <ConnectAccount publicUrl={publicUrl} apiBase={status?.hosted_api_base ?? 'https://api.tokensrank.ai'} onConnected={async () => { await refreshStatus(); }} />}
        {status?.connection_error && <p className="publish-error">{status.connection_error}</p>}
      </section>}
      {step === 2 && <section className="publish-panel"><p className="dash-eyebrow">03 / NOTHING SENT YET</p><h1>Your sharing receipt</h1><p className="publish-lead">These are the totals that will be added to your public profile. The receipt is a fixed snapshot of your local calculations.</p>
        <label className="publish-code-option"><input type="checkbox" checked={includeCode} disabled={busy} onChange={(event) => { setIncludeCode(event.target.checked); void prepareReceipt(event.target.checked); }} /><span>Include code contributions <small>Optional. Also sends selected repository names, selected branches, daily GitHub contribution counts, and counts of sessions with matched commit references.</small></span></label>
        {receipt && <SharingReceipt receipt={receipt} />}
        {includeCode && !receipt && !busy && <CodeRefresh errorMessage={error} onReady={() => void prepareReceipt(true)} />}
        {busy && <p role="status">Preparing your receipt on this device…</p>}
        {expired ? <p role="alert" className="publish-error">This receipt expired. <button className="dash-text-button" onClick={() => void prepareReceipt()}>Prepare a new receipt</button></p> : <label className="publish-consent"><input type="checkbox" checked={confirmed} disabled={!receipt || busy} onChange={(event) => setConfirmed(event.target.checked)} /><span>I reviewed this receipt and want to publish these totals to the leaderboard.</span></label>}
        <div className="publish-actions"><button className="dash-button primary" disabled={!confirmed || !receipt || expired || busy} onClick={() => void publish()}>Confirm & publish <ArrowRight size={16} /></button><span className="publish-footnote">Your local history stays private.</span></div>
      </section>}
      {step === 3 && <section className="publish-panel publish-completion" aria-live="polite"><p className="dash-eyebrow">04 / PUBLICATION</p><span className="publish-icon">{ready ? <Check size={28} /> : failed || error ? <FileCheck2 size={28} /> : <RefreshCw className="dash-spin" size={28} />}</span>
        <h1>{ready ? 'Your profile is published.' : failed ? 'Your profile was not updated.' : busy && !submitted ? 'Sending your confirmed summary' : verification === 'passed' ? 'Updating your public profile' : 'Publishing your summary'}</h1>
        <p className="publish-lead">{ready ? 'Your approved totals are now public. Your files and session history remain on this device.' : failed ? verification === 'failed' ? 'Code verification did not match. Refresh your GitHub data before including code again, or share usage totals only.' : 'Verification could not finish. Your last public profile was not changed. You can prepare a new receipt.' : verification === 'passed' ? 'The summary passed its checks. Your profile and leaderboard entry are being updated.' : 'Once the summary is received, processing continues even if you leave this page.'}</p>
        {!failed && !ready && <ol className="publish-progress"><li className={submitted || verification ? 'done' : ''}>Summary received</li><li className={verification === 'passed' ? 'done' : ''}>{includeCode || !receipt ? 'Verify shared totals and GitHub code' : 'Check shared totals'}</li><li>Update public profile and leaderboard</li></ol>}
        {pending && (includeCode || !receipt) && <p className="publish-footnote">GitHub checks may take several minutes for a large history. {run?.verification_started_at ? `Started ${new Date(run.verification_started_at).toLocaleTimeString()}.` : ''}</p>}
        {failed && run?.error && <details className="publish-advanced"><summary>What happened?</summary><p>{run.error}</p></details>}
        <div className="publish-actions">{ready && status?.public_profile_url ? <><a className="dash-button primary" href={status.public_profile_url}>View your public profile</a><a className="dash-button" href={new URL('/', publicUrl).href}>View leaderboard</a></> : failed ? <button className="dash-button primary" onClick={() => { setError(''); setIncludeCode(false); void prepareReceipt(false); }}>Review a new receipt</button> : !busy && <button className="dash-button" onClick={() => void refreshStatus().catch(() => setError('Could not reach the public dashboard.'))}>Check progress</button>}</div>
        {error && !pending && <button className="dash-button" onClick={() => { setError(''); void prepareReceipt(); }}>Review a new receipt</button>}
      </section>}
      {error && !(step === 2 && includeCode && !receipt) && <p className="publish-error" role="alert">{error}</p>}
      {step > 0 && step < 3 && <button className="publish-back" disabled={busy} onClick={() => { setStep(step - 1); setError(''); setConfirmed(false); }}>← Back</button>}
      <footer className="publish-footer"><ShieldCheck size={14} /> Calculated on your device. Shared only with your confirmation.</footer>
    </div>
  </main>;
}

function SharingReceipt({ receipt }: { receipt: Receipt }) {
  const p = receipt.payload;
  const dates = [...new Set(p.usage_daily.map((row) => row.date))].sort();
  const models = new Map<string, number>();
  for (const row of p.model_daily) models.set(row.model, (models.get(row.model) ?? 0) + row.total_tokens);
  const handle = receipt.public_profile_url ? new URL(receipt.public_profile_url).pathname.split('/').pop() : 'your profile';
  return <div className="sharing-receipt">
    <div className="receipt-title"><div><span>SHARING RECEIPT</span><h2>@{handle}</h2></div><span className="receipt-badge">Aggregates only</span></div>
    <dl className="receipt-totals"><div><dt>Date range</dt><dd>{dates.length ? `${dates[0]} → ${dates.at(-1)}` : 'No usage yet'}</dd></div><div><dt>Tokens</dt><dd>{p.summary.total_tokens.toLocaleString()}</dd></div><div><dt>{p.usage_evidence?.sources.some(s=>s.unpriced_models.length>0)?'Partial API value':'Estimated API value'}</dt><dd>{money(p.summary.total_cost_usd)}</dd></div><div><dt>Sessions · count only</dt><dd>{p.summary.sessions_count.toLocaleString()}</dd></div><div><dt>Daily usage totals</dt><dd>{dates.length} days</dd></div><div><dt>Tools</dt><dd>{[...new Set(p.usage_daily.map((row) => row.source))].join(', ') || '—'}</dd></div><div><dt>Models</dt><dd>{models.size}</dd></div></dl>
    <p className="publish-footnote">{p.usage_evidence?.sources.length && p.usage_evidence.sources.every(s=>s.daily_basis==='event_dates') ? 'Token totals follow recorded event dates in UTC.' : 'Daily token totals may use each session’s final date.'} Each session is counted once, on its last observed day. Session IDs and individual timelines stay on your device.</p>
    <details className="receipt-details"><summary>See model totals</summary><dl>{[...models].sort((a,b) => b[1]-a[1]).map(([model, tokens]) => <div key={model}><dt>{model}</dt><dd>{compact(tokens)} tokens</dd></div>)}</dl></details>
    {p.usage_evidence && <details className="receipt-details"><summary>Calculation and evidence details</summary>
      <p>Calculations use counters, dates and identifiers recorded by your tools. No AI inference is used. The public record will include:</p>
      <ul>{p.usage_evidence.sources.map(s=><li key={s.source}>{s.source}: {s.daily_basis==='event_dates'?'UTC event dates':'session summary dates'}{s.read_at?`, read ${new Date(s.read_at).toLocaleString()}`:''}{s.unpriced_models.length?`. Missing model prices: ${s.unpriced_models.join(', ')}`:''}</li>)}</ul>
      <p>Output tokens: {p.usage_daily.reduce((n,r)=>n+r.output_tokens,0).toLocaleString()}. Output includes reported reasoning; reasoning is not counted again.</p>
      {p.usage_evidence.sources.some(s=>s.unpriced_models.length>0)&&<p>API value is partial. Models without a price are excluded from the estimate.</p>}
      {p.usage_evidence.attribution&&<p>Matched commit references in {p.usage_evidence.attribution.linked_sessions.toLocaleString()} of {p.usage_evidence.attribution.sessions.toLocaleString()} sessions. Only these counts are shared; session IDs and commit-reference history stay private.</p>}
    </details>}
    {p.selected_repos.length > 0 && <details className="receipt-details"><summary>Code data included · {p.selected_repos.length} repositories</summary><p>Repository names and selected branches are sent for verification, with daily added-line and commit counts. Token-to-commit allocations, model-to-code estimates, commit messages and source files are excluded.</p><ul>{p.selected_repos.map((repo) => <li key={repo.repo_id}>{repo.full_name} · {repo.prod_branch}</li>)}</ul></details>}
    <div className="receipt-private"><LockKeyhole size={19} /><div><strong>Excluded from this receipt</strong><p>Conversations, prompts, commands, file contents, local paths, session IDs, session timelines and source file hashes.</p></div></div>
    <div className="receipt-bottom"><span>{(receipt.byte_size / 1024).toFixed(1)} KB · usage totals, calculation details and pricing fingerprints</span><button onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'tokensrank-sharing-receipt.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download exact data</button></div>
  </div>;
}
