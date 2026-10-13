import 'server-only';

import { revalidateTag } from 'next/cache';

import {
  ApiFetchError,
  CACHE_TAG_HEADER,
  getApiBaseUrl,
  type ApiErrorEnvelope,
  type ApiFetchMeta,
  type FetchOptions,
} from './api';

export type ServerFetchOptions = FetchOptions & {
  requestHeaders?: Headers | HeadersInit;
};

function buildApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const baseUrl = getApiBaseUrl().replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `${baseUrl}${normalizedPath}`;
}

function hasContentType(headers: Headers): boolean {
  return Array.from(headers.keys()).some((key) => key.toLowerCase() === 'content-type');
}

function mergeServerHeaders(options: ServerFetchOptions): Headers {
  const headers = new Headers(options.headers);
  const requestHeaders = new Headers(options.requestHeaders);
  const cookie = requestHeaders.get('cookie');
  const origin = requestHeaders.get('origin');
  const referer = requestHeaders.get('referer');

  if (cookie && !headers.has('cookie')) {
    headers.set('cookie', cookie);
  }

  if (referer && !headers.has('referer')) {
    headers.set('referer', referer);
  }

  if (origin && !headers.has('origin')) {
    headers.set('origin', origin);
  } else if (referer && !headers.has('origin')) {
    try {
      headers.set('origin', new URL(referer).origin);
    } catch {
      headers.set('referer', referer);
    }
  }

  if (!headers.has('accept')) {
    headers.set('Accept', 'application/json');
  }

  if (options.body !== undefined && !hasContentType(headers)) {
    headers.set('Content-Type', 'application/json');
  }

  return headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  return await response.json() as T;
}

async function readError(response: Response): Promise<ApiFetchError> {
  let message = `API request failed with status ${response.status}`;
  let code: string | undefined;
  let details: unknown;

  try {
    const body = await response.clone().json() as ApiErrorEnvelope;
    message = body.error?.message ?? message;
    code = body.error?.code;
    details = body.error?.details;
  } catch {
    const text = await response.text().catch(() => '');
    message = text || message;
  }

  return new ApiFetchError(message, response.status, code, details);
}

function parseCacheTags(headers: Headers): string[] {
  const value = headers.get(CACHE_TAG_HEADER);

  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

async function serverApiFetchWithMeta<T>(
  path: string,
  options: ServerFetchOptions = {},
): Promise<ApiFetchMeta<T>> {
  const { requestHeaders: _requestHeaders, ...fetchOptions } = options;
  const response = await fetch(buildApiUrl(path), {
    ...fetchOptions,
    credentials: fetchOptions.credentials ?? 'include',
    headers: mergeServerHeaders(options),
  });

  if (!response.ok) {
    throw await readError(response);
  }

  const cacheTags = parseCacheTags(response.headers);

  for (const tag of cacheTags) {
    revalidateTag(tag);
  }

  return {
    data: await parseJsonResponse<T>(response),
    status: response.status,
    headers: response.headers,
    cacheStatus: response.headers.get('x-tokensrank-cache'),
    cacheTags,
  };
}

export async function serverApiFetch<T>(
  path: string,
  options: ServerFetchOptions = {},
): Promise<T> {
  const response = await serverApiFetchWithMeta<T>(path, options);

  return response.data;
}

export { serverApiFetchWithMeta };
