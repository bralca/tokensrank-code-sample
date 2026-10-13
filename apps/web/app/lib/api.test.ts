import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ApiFetchError, apiFetch, apiFetchWithMeta } from './api';

const fetchMock = vi.fn<typeof fetch>();
const revalidateTagMock = vi.hoisted(() => vi.fn());

vi.mock('next/cache', () => ({
  revalidateTag: revalidateTagMock,
}));

function jsonResponse(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

function lastFetchInit(): RequestInit {
  const init = fetchMock.mock.calls.at(-1)?.[1];

  if (!init) {
    throw new Error('fetch was not called with RequestInit');
  }

  return init;
}

describe('apiFetch', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE = 'http://api.test';
    fetchMock.mockReset();
    revalidateTagMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('prepends NEXT_PUBLIC_API_BASE and includes default credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }, { status: 200 }));

    const response = await apiFetch<{ data: { ok: boolean } }>('/api/me');

    expect(response).toEqual({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/me', expect.objectContaining({
      credentials: 'include',
    }));
  });

  it('keeps absolute URLs untouched', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }, { status: 200 }));

    await apiFetch('https://api.example.test/api/leaderboard');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/api/leaderboard');
  });

  it('sets Accept and Content-Type headers for JSON request bodies', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { updated: true } }, { status: 200 }));

    await apiFetch('/api/me/profile', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Alex' }),
    });

    const headers = lastFetchInit().headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get('Accept')).toBe('application/json');
    expect((headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it.each([
    [400, 'schema_invalid'],
    [401, 'invalid_credentials'],
    [409, 'handle_taken'],
    [429, 'rate_limited'],
    [500, 'profile_update_failed'],
  ])('throws ApiError for %i error envelopes', async (status, code) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: {
        code,
        message: `${code} message`,
        details: { status },
      },
    }, { status }));

    try {
      await apiFetch('/api/me/profile');
      throw new Error('apiFetch should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        name: 'ApiFetchError',
        status,
        code,
        message: `${code} message`,
        details: { status },
      });
    }
  });

  it('parses cache tags and exposes response metadata', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { data: { updated: true } },
      {
        status: 200,
        headers: {
          'x-cache-tags': 'profile, leaderboard',
          'x-tokensrank-cache': 'MISS',
        },
      },
    ));

    const response = await apiFetchWithMeta<{ data: { updated: boolean } }>('/api/me/profile', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Alex' }),
    });

    expect(response.cacheTags).toEqual(['profile', 'leaderboard']);
    expect(response.cacheStatus).toBe('MISS');
  });

  it('revalidates response cache tags when called without a browser window', async () => {
    const browserWindow = globalThis.window;
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { data: { updated: true } },
      {
        status: 200,
        headers: {
          'x-cache-tags': 'profile, leaderboard',
        },
      },
    ));

    try {
      vi.stubGlobal('window', undefined);
      await apiFetch('/api/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: 'Alex' }),
      });
    } finally {
      vi.stubGlobal('window', browserWindow);
    }

    expect(revalidateTagMock).toHaveBeenCalledWith('profile');
    expect(revalidateTagMock).toHaveBeenCalledWith('leaderboard');
  });

  it('returns undefined for 204 responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(apiFetch('/api/auth/sign-out')).resolves.toBeUndefined();
  });

  it('falls back to status message when the response is not an error envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response('broken', { status: 500 }));

    await expect(apiFetch('/api/me')).rejects.toEqual(
      new ApiFetchError('broken', 500, undefined, undefined),
    );
  });
});
