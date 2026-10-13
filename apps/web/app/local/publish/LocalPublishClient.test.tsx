import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalPublishClient } from './LocalPublishClient';

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiFetch: mock.fetch }));
vi.mock('../../components/dashboard/Brand', () => ({ Brand: () => <span>tokensrank</span> }));
let root: Root; let container: HTMLDivElement;
const base = { token_connected: true, connection_status: 'connected', hosted_api_base: 'http://localhost:3201', public_profile_url: 'http://localhost:3200/u/fixture', hosted_status: null };
const payload = { schema_version: 2, model_daily: [{ date: '2026-09-14', source: 'codex', model: 'test-model', total_tokens: 100 }], usage_daily: [{ date: '2026-09-14', source: 'codex' }], usage_session_rollups: [], selected_repos: [], summary: { total_tokens: 100, total_cost_usd: 1, sessions_count: 2 } };
const receipt = { receipt_id: 'receipt-1', expires_at: '2099-01-01T00:00:00Z', byte_size: 500, payload, public_profile_url: base.public_profile_url };
const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); mock.fetch.mockReset();
  mock.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/setup/status')) return { operations: [], profile_ready: true, usage_sources: [], ingestion: {} };
    if (url.includes('/api/profile/')) return { headline: { tokens_total: 100, cost_usd_total: 1 }, at_glance: { sessions_count: 2 } };
    if (url.endsWith('/receipt')) return { data: receipt };
    if (url.endsWith('/send')) return { data: { publish_run_id: 'run', verification_status: 'pending' } };
    return { data: base };
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function review() { await act(async () => root.render(<LocalPublishClient />)); await click('Continue'); await click('Review what will be shared'); }
describe('guided publishing receipt', () => {
  it('keeps publishing disabled until the receipt is explicitly approved and sends its ID only', async () => {
    await review();
    expect(button('Confirm & publish').disabled).toBe(true);
    expect(container.textContent).toContain('session IDs, session timelines');
    expect(mock.fetch.mock.calls.some(([url]) => url.endsWith('/send'))).toBe(false);
    const checkbox = container.querySelector('.publish-consent input') as HTMLInputElement;
    await act(async () => checkbox.click());
    expect(button('Confirm & publish').disabled).toBe(false);
    await click('Confirm & publish');
    expect(mock.fetch).toHaveBeenCalledWith('/local/publish/send', { method: 'POST', body: JSON.stringify({ receipt_id: 'receipt-1', confirmed: true }) });
  });
  it('clears approval and prepares a new receipt when the scope changes', async () => {
    await review();
    await act(async () => (container.querySelector('.publish-consent input') as HTMLInputElement).click());
    await act(async () => (container.querySelector('.publish-code-option input') as HTMLInputElement).click());
    expect(button('Confirm & publish').disabled).toBe(true);
    expect(mock.fetch).toHaveBeenCalledWith('/local/publish/receipt', { method: 'POST', body: JSON.stringify({ include_code: true }) });
  });
  it('explains a GitHub pause and allows an aggregate receipt without waiting for code', async () => {
    const existing = mock.fetch.getMockImplementation()!;
    const paused = 'GitHub refresh paused: API request limit reached. Try again after 2099-01-01T00:00:00.000Z.';
    mock.fetch.mockImplementation(async (url: string, options?: { body?: string }) => {
      if (url.endsWith('/receipt') && JSON.parse(options?.body ?? '{}').include_code) throw new Error(paused);
      if (url.includes('/setup/status')) return { operations: [], profile_ready: true, usage_sources: [], ingestion: {}, github: { login: 'fixture' }, repos: [{ selected: true, remote_sync_error: paused }] };
      return existing(url, options);
    });
    await review();
    await act(async () => (container.querySelector('.publish-code-option input') as HTMLInputElement).click());
    expect(container.textContent).toContain('GitHub refresh is paused');
    expect(button('Refresh GitHub totals').disabled).toBe(true);
    expect(button('Confirm & publish').disabled).toBe(true);
    await act(async () => (container.querySelector('.publish-code-option input') as HTMLInputElement).click());
    expect(container.textContent).toContain('Aggregates only');
    expect(container.textContent).not.toContain('GitHub refresh is paused');
    expect(button('Confirm & publish').disabled).toBe(true);
    expect(mock.fetch.mock.calls.some(([url]) => url.endsWith('/send'))).toBe(false);
  });
  it('shows a terminal failure instead of a stale accepted message and stops polling', async () => {
    vi.useFakeTimers();
    const existing = mock.fetch.getMockImplementation()!;
    let failed = false; let reads = 0;
    mock.fetch.mockImplementation(async (url: string) => {
      if (!url.endsWith('/status') || url.includes('/setup/')) return existing(url);
      reads++;
      return { data: { ...base, hosted_status: { data: { publish_run: { verification_status: failed ? 'failed' : 'processing', publication_ready: false, error: failed ? 'Code totals differ.' : null } } } } };
    });
    await act(async () => root.render(<LocalPublishClient />));
    expect(container.textContent).toContain('Publishing your summary');
    failed = true; await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.textContent).toContain('Your profile was not updated.');
    expect(container.textContent).not.toContain('Publish accepted');
    const count = reads; await act(async () => vi.advanceTimersByTimeAsync(9_000)); expect(reads).toBe(count);
  });
  it('waits for profile preparation before showing the public profile link', async () => {
    vi.useFakeTimers(); const existing = mock.fetch.getMockImplementation()!; let ready = false;
    mock.fetch.mockImplementation(async (url: string) => url.endsWith('/publish/status') ? { data: { ...base, hosted_status: { data: { publish_run: { verification_status: 'passed', publication_ready: ready } } } } } : existing(url));
    await act(async () => root.render(<LocalPublishClient />));
    expect(container.textContent).toContain('Updating your public profile');
    ready = true; await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.querySelector(`a[href="${base.public_profile_url}"]`)?.textContent).toBe('View your public profile');
  });
});
