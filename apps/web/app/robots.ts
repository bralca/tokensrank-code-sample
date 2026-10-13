import type { MetadataRoute } from 'next';

import { getSiteUrl } from '../lib/sitemap';

export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl();

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/auth',
        '/onboarding',
        '/me',
        '/local',
        '/connect',
        '/api',
        '/models/by-name',
      ],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
