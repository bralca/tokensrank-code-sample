import {
  buildSitemapEntries,
  getSiteUrl,
  loadSitemapProfileHandles,
  loadDimensionSitemapEntries,
  serializeSitemapXml,
  SITEMAP_MAX_URLS,
} from '../../lib/sitemap';

export const revalidate = 3600;

export async function GET(): Promise<Response> {
  const handles = await loadSitemapProfileHandles();
  const entries = [...buildSitemapEntries(getSiteUrl(), handles, new Date()), ...await loadDimensionSitemapEntries(getSiteUrl())].slice(0, SITEMAP_MAX_URLS);

  return new Response(serializeSitemapXml(entries), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
