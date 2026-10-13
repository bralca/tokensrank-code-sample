import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AuthCallbackPage from './page';

const mock = vi.hoisted(() => ({router:{replace:vi.fn(),refresh:vi.fn()}}));
vi.mock('next/navigation', () => ({useRouter:()=>mock.router}));
vi.mock('../../../lib/api', () => ({getApiBaseUrl:()=> 'http://localhost:3201'}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  container=document.createElement('div');
  root=createRoot(container);
  vi.clearAllMocks();
  sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  window.history.replaceState(null,'','/');
  vi.unstubAllGlobals();
});
it('exchanges a GitHub session once in Strict Mode, clears the hash immediately and opens the account', async () => {
  let finish!: (value: Response) => void;
  const fetchMock=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  vi.stubGlobal('fetch',fetchMock);
  window.history.replaceState(null,'','/auth/callback#access_token=test-access&refresh_token=test-refresh&provider_token=test-provider');
  await act(async () => root.render(<StrictMode><AuthCallbackPage /></StrictMode>));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe('');
  expect(mock.router.replace).not.toHaveBeenCalled();
  await act(async () => finish({ok:true} as Response));
  expect(mock.router.replace).toHaveBeenCalledExactlyOnceWith('/me');
});
it('shows a retry action if the exchange fails and leaves no tokens in the URL', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false}));
  window.history.replaceState(null,'','/auth/callback#access_token=test-access&refresh_token=test-refresh');
  await act(async () => root.render(<AuthCallbackPage />));
  expect(window.location.hash).toBe('');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('try again');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/auth/sign-in');
  expect(mock.router.replace).not.toHaveBeenCalled();
});
it('handles an expired callback without submitting an empty session', async () => {
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  window.history.replaceState(null,'','/auth/callback');
  await act(async () => root.render(<StrictMode><AuthCallbackPage /></StrictMode>));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.textContent).toContain('expired');
});
it.each(['/connect/local?state=test&local_origin=http%3A%2F%2Flocalhost%3A3100', 'https://foreign.example', '//foreign.example'])('returns safely after GitHub sign-in: %s', async (returnTo) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  sessionStorage.setItem('tokensrank:auth-return', returnTo);
  window.history.replaceState(null, '', '/auth/callback#access_token=test-access&refresh_token=test-refresh');
  await act(async () => root.render(<AuthCallbackPage />));
  expect(mock.router.replace).toHaveBeenCalledWith(returnTo.startsWith('/connect/local?') ? returnTo : '/me');
  expect(sessionStorage.getItem('tokensrank:auth-return')).toBeNull();
});
