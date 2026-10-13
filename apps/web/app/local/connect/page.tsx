'use client';

import { useEffect, useRef, useState } from 'react';
import { Brand } from '../../components/dashboard/Brand';

export default function LocalConnectionReturn() {
  const request = useRef<{ state: string; code: string; public_origin: string } | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!request.current) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      window.history.replaceState(null, '', '/local/connect');
      const state = params.get('state') ?? '';
      const code = params.get('code') ?? '';
      const origin = params.get('public_origin') ?? '';
      try {
        const url = new URL(origin);
        if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(state) || code.length < 16) throw new Error();
        request.current = { state, code, public_origin: origin };
      } catch { setError('This connection link expired. Start again from the publishing wizard.'); return; }
    }
    if (typeof BroadcastChannel === 'undefined') { setError('This browser cannot return the connection automatically. Use the manual connection option in the publishing wizard.'); return; }
    const value = request.current;
    const channel = new BroadcastChannel(`tokensrank:connect:${value.state}`);
    const send = () => channel.postMessage({ type: 'tokensrank:connect', ...value });
    const interval = setInterval(send, 500);
    const timeout = setTimeout(() => { clearInterval(interval); setError('The original publishing window is not responding. Return there and reconnect.'); }, 30_000);
    channel.onmessage = (event) => {
      if (event.data?.type !== 'tokensrank:connected' || event.data.state !== value.state) return;
      clearInterval(interval); clearTimeout(timeout); setConnected(true); setError(''); request.current = null;
      window.close();
    };
    send();
    return () => { clearInterval(interval); clearTimeout(timeout); channel.close(); };
  }, []);
  return <main className="dashboard"><div className="publish-popup"><Brand href="/local/profile" /><h1>{connected ? 'Account connected' : 'Returning to your receipt'}</h1><p role={error ? 'alert' : 'status'}>{error || (connected ? 'Continue in your original publishing window. You can close this window.' : 'Connecting the account to your local app. Nothing is being published.')}</p></div></main>;
}
