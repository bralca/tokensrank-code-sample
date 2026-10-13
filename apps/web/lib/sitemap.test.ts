import { describe, expect, it, vi } from 'vitest';

import {
  buildLeaderboardFilterUrls,
  buildSitemapEntries,
  getSiteUrl,
  serializeSitemapXml,
  SITEMAP_MAX_URLS,
} from './sitemap';

describe('sitemap helpers', () => {
  it('normalizes the configured site URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com/');

    expect(getSiteUrl()).toBe('https://example.com');

    vi.unstubAllEnvs();
  });

  it('lists canonical directories instead of duplicate filter permutations', () => {
    const urls = buildLeaderboardFilterUrls('https://tokensrank.ai');

    expect(urls).toHaveLength(3);
    expect(urls).toContainEqual({
      url: 'https://tokensrank.ai/models',
      changeFrequency: 'daily',
      priority: 0.8,
    });
    expect(urls).toContainEqual({
      url: 'https://tokensrank.ai/tools',
      changeFrequency: 'daily',
      priority: 0.8,
    });
  });

  it('builds homepage, leaderboard, and profile sitemap entries with priorities', () => {
    const lastModified = new Date('2026-04-28T10:00:00.000Z');
    const entries = buildSitemapEntries(
      'https://tokensrank.ai',
      ['Alex', 'bad space', 'alex', 'beatriz'],
      lastModified,
    );

    expect(entries[0]).toEqual({
      url: 'https://tokensrank.ai',
      lastModified,
      changeFrequency: 'daily',
      priority: 1.0,
    });
    expect(entries).toContainEqual({
      url: 'https://tokensrank.ai/u/alex',
      lastModified,
      changeFrequency: 'daily',
      priority: 0.7,
    });
    expect(entries).toContainEqual({
      url: 'https://tokensrank.ai/u/beatriz',
      lastModified,
      changeFrequency: 'daily',
      priority: 0.7,
    });
    expect(entries.filter((entry) => entry.url === 'https://tokensrank.ai/u/alex')).toHaveLength(1);
    expect(entries.some((entry) => entry.url.includes('bad space'))).toBe(false);
  });

  it('never exceeds the sitemap URL cap', () => {
    const profileHandles = Array.from(
      { length: SITEMAP_MAX_URLS + 100 },
      (_, index) => `profile_${index}`,
    );
    const entries = buildSitemapEntries('https://tokensrank.ai', profileHandles, new Date());

    expect(entries).toHaveLength(SITEMAP_MAX_URLS);
  });

  it('serializes XML with escaped query separators and one-decimal priorities', () => {
    const xml = serializeSitemapXml([
      {
        url: 'https://tokensrank.ai/leaderboard?period=all&scope=all',
        changeFrequency: 'daily',
        priority: 0.8,
      },
      {
        url: 'https://tokensrank.ai',
        priority: 1.0,
      },
    ]);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('https://tokensrank.ai/leaderboard?period=all&amp;scope=all');
    expect(xml).toContain('<priority>0.8</priority>');
    expect(xml).toContain('<priority>1.0</priority>');
  });
});
