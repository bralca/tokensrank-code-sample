import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import LocalConnectionReturn from './page';

vi.mock('../../components/dashboard/Brand', () => ({ Brand: () => <span>tokensrank</span> }));
it('returns the one-use code locally without an opener and clears it from the URL', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const channels: TestChannel[] = [];
  class TestChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage = vi.fn(); close = vi.fn();
    constructor(public name: string) { channels.push(this); }
  }
  vi.stubGlobal('BroadcastChannel', TestChannel);
  const closed = vi.spyOn(window, 'close').mockImplementation(() => {});
  const state = '11111111-1111-4111-8111-111111111111';
  window.history.replaceState(null, '', `/local/connect#state=${state}&code=test-one-use-code&public_origin=https%3A%2F%2Ftokensrank.ai`);
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => root.render(<StrictMode><LocalConnectionReturn /></StrictMode>));
    expect(window.location.hash).toBe('');
    const channel = channels.at(-1)!;
    expect(channel.name).toBe(`tokensrank:connect:${state}`);
    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'tokensrank:connect', state, code: 'test-one-use-code', public_origin: 'https://tokensrank.ai' });
    await act(async () => channel.onmessage!({ data: { type: 'tokensrank:connected', state: 'wrong' } }));
    expect(closed).not.toHaveBeenCalled();
    await act(async () => channel.onmessage!({ data: { type: 'tokensrank:connected', state } }));
    expect(closed).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Account connected');
  } finally { await act(async () => root.unmount()); closed.mockRestore(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); }
});
