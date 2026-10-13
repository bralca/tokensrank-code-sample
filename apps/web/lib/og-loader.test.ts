import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('./api', () => {
  class ApiFetchError extends Error {
    public readonly status: number;

    public constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiFetchError';
      this.status = status;
    }
  }

  return {
    ApiFetchError,
    apiFetch: apiFetchMock,
  };
});

import { ApiFetchError } from './api';
import { formatCost, formatTokens, loadOGProfileData, OGProfileNotFoundError } from './og-loader';

describe('formatTokens', () => {
  it('formats compact token counts', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1_000)).toBe('1K');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(1_000_000_000)).toBe('1B');
    expect(formatTokens(42_500_000_000)).toBe('42.5B');
  });
});

describe('formatCost', () => {
  it('formats actual API value without deriving it from tokens', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(33459.53)).toBe('$33,459.53');
    expect(formatCost(null)).toBe('API value unavailable');
  });
});

describe('loadOGProfileData', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('loads and validates flat OG profile data', async () => {
    apiFetchMock.mockResolvedValue({
      handle: 'alex',
      display_name: 'Alex Builder',
      total_tokens: 1_500_000,
      avatar_url: 'https://example.com/avatar.png',
      mode: 'script_verified',
      rank: 3,
    });

    await expect(loadOGProfileData('alex')).resolves.toMatchObject({
      profile: {
        handle: 'alex',
        display_name: 'Alex Builder',
        total_tokens: 1_500_000,
        avatar_url: 'https://example.com/avatar.png',
        mode: 'script_verified',
        rank: 3,
      },
      formatTokens,
      formatCost,
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/profile/alex?window=all', {
      cache: 'no-store',
    });
  });

  it('maps nested public profile data into the OG profile shape', async () => {
    apiFetchMock.mockResolvedValue({
      identity: {
        handle: 'alex',
        display_name: null,
        avatar_url: 'https://example.com/avatar.png',
        mode: 'self_reported',
      },
      headline: {
        rank: null,
        tokens_total: 1_000,
        cost_usd_total: 12.34,
      },
    });

    await expect(loadOGProfileData('alex')).resolves.toMatchObject({
      profile: {
        handle: 'alex',
        display_name: 'alex',
        total_tokens: 1_000,
        cost_usd_total: 12.34,
        avatar_url: 'https://example.com/avatar.png',
        mode: 'self_reported',
      },
    });
  });

  it('throws a descriptive not found error for 404 responses', async () => {
    apiFetchMock.mockRejectedValue(new ApiFetchError('missing', 404));

    await expect(loadOGProfileData('missing')).rejects.toThrow(OGProfileNotFoundError);
    await expect(loadOGProfileData('missing')).rejects.toThrow('missing');
  });
});
