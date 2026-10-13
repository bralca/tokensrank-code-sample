'use client';

import { useEffect, useRef, useState } from 'react';
import { Github, ExternalLink } from 'lucide-react';
import { apiFetch } from '../../lib/api';

export function ConnectAccount({ publicUrl, apiBase, onConnected }: { publicUrl: string; apiBase: string; onConnected: () => Promise<void> }) {
  const popup = useRef<Window | null>(null);
  const nonce = useRef('');
  const connecting = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const publicOrigin = new URL(publicUrl).origin;

  async function connect(value: string) {
    if (connecting.current) return;
    connecting.current = true;
    setBusy(true); setError('');
    try {
      await apiFetch('/local/publish/connect', { method: 'POST', body: JSON.stringify({ code: value, hosted_api_base: apiBase }) });
      channel.current?.postMessage({ type: 'tokensrank:connected', state: nonce.current });
      try { popup.current?.postMessage({ type: 'tokensrank:connected', state: nonce.current }, publicOrigin); } catch { /* OAuth can sever the original window reference. */ }
      nonce.current = '';
      setCode('');
      await onConnected();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not connect your account.'); }
    finally { connecting.current = false; setBusy(false); }
  }

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== publicOrigin || event.source !== popup.current || !nonce.current) return;
      if (event.data?.type !== 'tokensrank:connect' || event.data.state !== nonce.current || typeof event.data.code !== 'string') return;
      void connect(event.data.code);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  });
  useEffect(() => () => channel.current?.close(), []);

  return <div className="publish-connect">
    <span className="publish-icon"><Github size={28} /></span>
    <h2>Choose your public identity</h2>
    <p>Sign in with GitHub in a small window. You’ll return here to review your receipt. Connecting does not publish your usage.</p>
    <button className="dash-button dark" disabled={busy} onClick={() => {
      nonce.current = crypto.randomUUID();
      channel.current?.close();
      if (typeof BroadcastChannel !== 'undefined') {
        const bridge = new BroadcastChannel(`tokensrank:connect:${nonce.current}`);
        bridge.onmessage = (event) => {
          if (event.data?.type !== 'tokensrank:connect' || event.data.state !== nonce.current || event.data.public_origin !== publicOrigin || typeof event.data.code !== 'string') return;
          void connect(event.data.code);
        };
        channel.current = bridge;
      }
      const url = new URL('/connect/local', publicOrigin);
      url.searchParams.set('state', nonce.current); url.searchParams.set('local_origin', window.location.origin);
      popup.current = window.open(url, 'tokensrank-connect', 'popup,width=600,height=740');
      if (!popup.current) setError('Allow the connection window, or use the manual connection below.');
    }}><Github size={17} /> {busy ? 'Connecting…' : 'Continue with GitHub'}</button>
    <details className="publish-advanced"><summary>Connection window not working?</summary>
      <p><a href={new URL('/me', publicOrigin).href} target="_blank" rel="noreferrer">Open your public account <ExternalLink size={13} /></a> and create a connection code.</p>
      <label htmlFor="connection-code">Connection code</label>
      <div className="publish-inline"><input id="connection-code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" /><button className="dash-button" disabled={busy || code.trim().length < 16} onClick={() => void connect(code.trim())}>Connect</button></div>
    </details>
    {error && <p role="alert" className="publish-error">{error}</p>}
  </div>;
}
