import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const maxRedirects = 3;
const maxBytes = 3 * 1024 * 1024;
const timeoutMs = 8000;
const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === 'metadata.google.internal';
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const octets = address.split('.').map((part) => Number(part));
    const [first = 0, second = 0] = octets;

    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }

  if (version === 6) {
    const normalized = address.toLowerCase();

    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.');
  }

  return true;
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Avatar URL must use http or https');
  }

  if (isBlockedHostname(url.hostname)) {
    throw new Error('Avatar URL host is not allowed');
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: false });

  if (addresses.length === 0 || addresses.some((address) => isBlockedIp(address.address))) {
    throw new Error('Avatar URL resolved to a private address');
  }
}

async function fetchAvatar(url: URL, redirects = 0): Promise<Response> {
  await assertPublicHttpUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        accept: allowedImageTypes.join(','),
        'user-agent': 'TokensRankAvatarProxy/1.0',
      },
      redirect: 'manual',
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirects >= maxRedirects) {
        throw new Error('Avatar URL redirects too many times');
      }

      const location = response.headers.get('location');

      if (!location) {
        throw new Error('Avatar URL redirect missing location');
      }

      return fetchAvatar(new URL(location, url), redirects + 1);
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rawUrl = request.nextUrl.searchParams.get('url');

  if (!rawUrl) {
    return NextResponse.json({ error: 'Missing avatar URL' }, { status: 400 });
  }

  let avatarUrl: URL;

  try {
    avatarUrl = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid avatar URL' }, { status: 400 });
  }

  try {
    const response = await fetchAvatar(avatarUrl);

    if (!response.ok) {
      return NextResponse.json({ error: 'Avatar URL could not be loaded' }, { status: 422 });
    }

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';

    if (!allowedImageTypes.includes(contentType)) {
      return NextResponse.json({ error: 'Avatar URL must return an image' }, { status: 415 });
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0');

    if (contentLength > maxBytes) {
      return NextResponse.json({ error: 'Avatar image is too large' }, { status: 413 });
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    if (bytes.byteLength > maxBytes) {
      return NextResponse.json({ error: 'Avatar image is too large' }, { status: 413 });
    }

    return new NextResponse(bytes, {
      headers: {
        'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
        'content-length': String(bytes.byteLength),
        'content-type': contentType,
        'x-content-type-options': 'nosniff',
      },
      status: 200,
    });
  } catch {
    return NextResponse.json({ error: 'Avatar URL could not be loaded' }, { status: 422 });
  }
}
