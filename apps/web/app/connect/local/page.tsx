'use client';

import { useEffect, useState } from 'react';
import { Github, Laptop, ShieldCheck } from 'lucide-react';
import { Brand } from '../../components/dashboard/Brand';
import { apiFetch, getApiBaseUrl } from '../../../lib/api';

export default function ConnectLocalPage() {
  const [request, setRequest] = useState<{ origin: string; state: string } | null>(null);
  const [account, setAccount] = useState<{ handle: string; displayName?: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    try {
      const local = new URL(params.get('local_origin') ?? '');
      const state = params.get('state') ?? '';
      if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || !['http:', 'https:'].includes(local.protocol) || local.origin !== params.get('local_origin') || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(state)) throw new Error();
      setRequest({ origin: local.origin, state });
    } catch { setError('Start the connection from Publishing in your local app.'); }
    void apiFetch<{ data: { handle: string; displayName?: string } }>('/api/me', { credentials: 'include' })
      .then((result) => setAccount(result.data)).catch(() => {}).finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    const received = (event: MessageEvent) => {
      if (event.origin === request?.origin && event.source === window.opener && event.data?.type === 'tokensrank:connected' && event.data.state === request?.state) window.close();
    };
    window.addEventListener('message', received); return () => window.removeEventListener('message', received);
  }, [request]);
  return <main className="dashboard"><div className="publish-popup">
    <Brand /><span className="publish-icon"><Laptop size={28} /></span>
    <h1>Connect this computer</h1>
    <p>{account ? `Use @${account.handle} for your public profile.` : 'Sign in with GitHub to choose your public identity.'}</p>
    <p className="publish-private-note"><ShieldCheck size={18} /> Your usage stays local until you confirm a sharing receipt.</p>
    {loaded && request && !account && <a className="dash-button dark" href={`${getApiBaseUrl()}/api/auth/github/start`} onClick={() => sessionStorage.setItem('tokensrank:auth-return', window.location.pathname + window.location.search)}><Github size={17} /> Continue with GitHub</a>}
    {account && request && <button className="dash-button primary" disabled={busy || sent} onClick={async () => {
      setBusy(true); setError('');
      try {
        const response = await apiFetch<{ data: { code: string } }>('/api/publish/link/start', { method: 'POST', credentials: 'include' });
        setSent(true);
        // OAuth providers may sever window.opener. Return to the local origin so
        // its original wizard can receive the one-use code on a private channel.
        // Fragments are not sent to the local web server or placed in referrers.
        const callback = new URL('/local/connect', request.origin);
        callback.hash = new URLSearchParams({ state: request.state, code: response.data.code, public_origin: window.location.origin }).toString();
        window.location.replace(callback.href);
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not connect. Please try again.'); }
      finally { setBusy(false); }
    }}>{sent ? 'Returning to your local app…' : busy ? 'Connecting…' : `Connect @${account.handle}`}</button>}
    {request && <p className="publish-footnote">Connecting to {request.origin} on this computer.</p>}
    {error && <p role="alert" className="publish-error">{error}</p>}
  </div></main>;
}
