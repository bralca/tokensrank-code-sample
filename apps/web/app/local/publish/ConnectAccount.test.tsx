import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ConnectAccount } from './ConnectAccount';

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiFetch: mock.fetch }));

it('accepts the local return channel only for the current state and public origin, once', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const channels: TestChannel[] = [];
  class TestChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage = vi.fn(); close = vi.fn();
    constructor(public name: string) { channels.push(this); }
  }
  vi.stubGlobal('BroadcastChannel', TestChannel);
  // Simulates OAuth severing the popup reference. The local channel still works.
  const opened = vi.spyOn(window, 'open').mockReturnValue({ postMessage: () => { throw new Error('Window severed'); } } as unknown as Window);
  const container = document.createElement('div'); const root = createRoot(container);
  const onConnected = vi.fn().mockResolvedValue(undefined);
  mock.fetch.mockResolvedValue({});
  try {
    await act(async () => root.render(<ConnectAccount publicUrl="https://tokensrank.ai/me" apiBase="https://api.tokensrank.ai" onConnected={onConnected} />));
    await act(async () => container.querySelector('button')!.click());
    const state = new URL(String(opened.mock.calls[0]![0])).searchParams.get('state');
    const channel = channels[0]!;
    const message = { type: 'tokensrank:connect', state, public_origin: 'https://tokensrank.ai', code: 'test-one-use-code' };
    await act(async () => {
      channel.onmessage!({ data: { ...message, state: 'wrong' } });
      channel.onmessage!({ data: { ...message, public_origin: 'https://foreign.example' } });
    });
    expect(mock.fetch).not.toHaveBeenCalled();
    await act(async () => { channel.onmessage!({ data: message }); channel.onmessage!({ data: message }); });
    expect(mock.fetch).toHaveBeenCalledExactlyOnceWith('/local/publish/connect', { method: 'POST', body: JSON.stringify({ code: message.code, hosted_api_base: 'https://api.tokensrank.ai' }) });
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'tokensrank:connected', state });
    expect(onConnected).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); opened.mockRestore(); vi.unstubAllGlobals(); }
});
