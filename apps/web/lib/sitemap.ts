import { apiFetch } from './api';
import { loadUsageCatalog, dimensionPath } from '../app/lib/explorer';

export type SitemapEntry = {
  url: string;
  lastModified?: Date;
  changeFrequency?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
};

type LeaderboardRow = {
  handle: string;
};

type LeaderboardResponse = {
  data: LeaderboardRow[];
  total?: number;
};

export const SITEMAP_REVALIDATE_SECONDS = 3600;
export const SITEMAP_MAX_URLS = 50000;

const LEADERBOARD_PROFILE_LIMIT = 50;
const DEFAULT_SITE_URL = 'https://tokensrank.ai';
const HANDLE_PATTERN = /^[a-z0-9_-]{3,30}$/;
const NEXT_PRODUCTION_BUILD_PHASE = 'phase-production-build';

export function getSiteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL
      ?? process.env.PUBLIC_SITE_URL
      ?? DEFAULT_SITE_URL
  ).replace(/\/+$/u, '');
}

export function buildLeaderboardFilterUrls(siteUrl: string): SitemapEntry[] {
  return ['/models','/tools','/providers'].map(path=>({url:siteUrl+path,changeFrequency:'daily',priority:0.8}));
}

export async function loadDimensionSitemapEntries(siteUrl:string):Promise<SitemapEntry[]> {
  const catalogs=await Promise.allSettled((['model','tool','provider'] as const).map(kind=>loadUsageCatalog(kind)));
  return catalogs.flatMap(result=>result.status==='fulfilled'?result.value.filter(row=>row.builders>=3&&row.key!=='unknown').map(row=>({url:siteUrl+dimensionPath(row.kind,row.slug),changeFrequency:'daily' as const,priority:0.7})):[]);
}

export function buildSitemapEntries(siteUrl: string, handles: string[], lastModified: Date): SitemapEntry[] {
  const entries: SitemapEntry[] = [
    {
      url: siteUrl,
      lastModified,
      changeFrequency: 'daily',
      priority: 1.0,
    },
    ...buildLeaderboardFilterUrls(siteUrl),
  ];

  const seenHandles = new Set<string>();

  for (const rawHandle of handles) {
    const handle = rawHandle.trim().toLowerCase();

    if (!HANDLE_PATTERN.test(handle) || seenHandles.has(handle)) {
      continue;
    }

    entries.push({
      url: `${siteUrl}/u/${handle}`,
      lastModified,
      changeFrequency: 'daily',
      priority: 0.7,
    });

    seenHandles.add(handle);

    if (entries.length >= SITEMAP_MAX_URLS) {
      break;
    }
  }

  return entries;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function serializeEntry(entry: SitemapEntry): string {
  const lines = [
    '<url>',
    `<loc>${escapeXml(entry.url)}</loc>`,
  ];

  if (entry.lastModified) {
    lines.push(`<lastmod>${entry.lastModified.toISOString()}</lastmod>`);
  }

  if (entry.changeFrequency) {
    lines.push(`<changefreq>${entry.changeFrequency}</changefreq>`);
  }

  if (entry.priority !== undefined) {
    lines.push(`<priority>${entry.priority.toFixed(1)}</priority>`);
  }

  lines.push('</url>');

  return lines.join('\n');
}

export function serializeSitemapXml(entries: SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(serializeEntry),
    '</urlset>',
  ].join('\n');
}

export async function loadSitemapProfileHandles(): Promise<string[]> {
  if (process.env.NEXT_PHASE === NEXT_PRODUCTION_BUILD_PHASE) {
    return [];
  }

  try {
    const handles:string[]=[];
    for(let offset=0;offset<=10000;offset+=LEADERBOARD_PROFILE_LIMIT){
    const response = await apiFetch<LeaderboardResponse>(
      `/api/leaderboard?period=all&scope=all&limit=${LEADERBOARD_PROFILE_LIMIT}&offset=${offset}`,
      {
        next: {
          revalidate: SITEMAP_REVALIDATE_SECONDS,
          tags: ['sitemap', 'leaderboard'],
        },
      },
    );

    handles.push(...response.data.map(row=>row.handle));
    if(response.data.length<LEADERBOARD_PROFILE_LIMIT || (response.total!==undefined && handles.length>=response.total))break;
    }
    return handles;
  } catch (error) {
    console.warn('[sitemap] Failed to load profile handles for sitemap', error);

    return [];
  }
}
