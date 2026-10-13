import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { ImageResponse } from '@vercel/og';

import { OGCardVariantA } from '../../../../components/og-card-variant-a';
import { OGCardVariantB } from '../../../../components/og-card-variant-b';
import { loadGeistFont } from '../../../../lib/og-fonts';
import { loadOGProfileData, OGProfileNotFoundError } from '../../../../lib/og-loader';

export const revalidate = 3600;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;
const CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';
const VARY_HEADER = 'Accept-Encoding';
const HANDLE_PATTERN = /^[a-z0-9_-]{3,30}$/;
const OG_CACHE_TTL_MS = 3600 * 1000;
const OG_FONT_TIMEOUT_MS = Number.parseInt(process.env.OG_FONT_TIMEOUT_MS ?? '2000', 10);

type CachedImage = {
  body: ArrayBuffer;
  etag: string;
  expiresAt: number;
};

const imageCache = new Map<string, CachedImage>();

type RouteContext = {
  params: Promise<Record<string, string | undefined>>;
};

async function resolveHandle(request: Request, params: RouteContext['params']): Promise<string> {
  const resolvedParams = await params;

  if (resolvedParams.handle) {
    return resolvedParams.handle;
  }

  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/\/og\/u\/([^/]+?)(?:\.png)?$/);
  return match?.[1] ?? '';
}

function parseVariant(request: Request): 'a' | 'b' {
  const variant = new URL(request.url).searchParams.get('v');
  return variant === 'a' ? 'a' : 'b';
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function createETag(arrayBuffer: ArrayBuffer): string {
  const hash = createHash('sha256')
    .update(Buffer.from(arrayBuffer))
    .digest('hex')
    .slice(0, 16);

  return `"${hash}"`;
}

function requestHasMatchingETag(request: Request, etag: string): boolean {
  const ifNoneMatch = request.headers.get('if-none-match');

  if (!ifNoneMatch) {
    return false;
  }

  return ifNoneMatch
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === etag || value === `W/${etag}`);
}

function cacheKey(handle: string, variant: 'a' | 'b'): string {
  return `${handle}:${variant}`;
}

function getCachedImage(key: string): CachedImage | null {
  const cached = imageCache.get(key);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    imageCache.delete(key);
    return null;
  }

  return cached;
}

function setCachedImage(key: string, image: Omit<CachedImage, 'expiresAt'>): void {
  imageCache.set(key, {
    ...image,
    expiresAt: Date.now() + OG_CACHE_TTL_MS,
  });
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const handle = await resolveHandle(request, context.params);

  if (!HANDLE_PATTERN.test(handle)) {
    return errorResponse('Invalid handle', 400);
  }

  try {
    const variant = parseVariant(request);
    const key = cacheKey(handle, variant);
    const cached = getCachedImage(key);

    if (cached) {
      const headers = {
        'Content-Type': 'image/png',
        'Cache-Control': CACHE_CONTROL,
        ETag: cached.etag,
        Vary: VARY_HEADER,
      };

      if (requestHasMatchingETag(request, cached.etag)) {
        return new Response(null, {
          status: 304,
          headers,
        });
      }

      return new Response(cached.body, {
        status: 200,
        headers,
      });
    }

    const [{ profile }, fontData] = await Promise.all([
      loadOGProfileData(handle),
      loadGeistFont(OG_FONT_TIMEOUT_MS),
    ]);

    const component = variant === 'a' ? OGCardVariantA : OGCardVariantB;
    const jsx = createElement(component, { profile });

    const imageResponse = new ImageResponse(jsx, {
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      fonts: fontData
        ? [
          {
            name: 'Geist',
            data: fontData,
            style: 'normal',
            weight: 400,
          },
        ]
        : [],
    });
    const imageBody = await imageResponse.arrayBuffer();
    const etag = createETag(imageBody);
    setCachedImage(key, {
      body: imageBody,
      etag,
    });
    const headers = {
      'Content-Type': 'image/png',
      'Cache-Control': CACHE_CONTROL,
      ETag: etag,
      Vary: VARY_HEADER,
    };

    if (requestHasMatchingETag(request, etag)) {
      return new Response(null, {
        status: 304,
        headers,
      });
    }

    return new Response(imageBody, {
      status: 200,
      headers,
    });
  } catch (error) {
    if (error instanceof OGProfileNotFoundError) {
      return errorResponse(error.message, 404);
    }

    console.error('[og] Image generation failed', error);
    return errorResponse('Failed to generate image', 500);
  }
}
