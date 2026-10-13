import { webEnv } from '../env';

export type ApiErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

export type FetchOptions = RequestInit & {
  next?: {
    revalidate?: number;
    tags?: string[];
  };
};

export type ApiFetchMeta<T> = {
  data: T;
  status: number;
  headers: Headers;
  cacheStatus: string | null;
  cacheTags: string[];
};

export const CACHE_TAG_HEADER = 'x-cache-tags';

export const API_CACHE_TAGS_BY_ENDPOINT = {
  'PATCH /api/me/profile': ['profile', 'leaderboard'],
  'POST /api/access-keys/generate': ['me'],
  'DELETE /api/access-keys/:key_id': ['me'],
  'POST /api/me/usage/import': ['profile', 'leaderboard', 'me'],
} as const;

export class ApiError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly details?: unknown;

  public constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ApiFetchError extends ApiError {
  public constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message, status, code, details);
    this.name = 'ApiFetchError';
  }
}

export function getApiBaseUrl(): string {
  return webEnv.NEXT_PUBLIC_API_BASE;
}

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

function mergeHeaders(options: FetchOptions): Headers {
  const headers = new Headers(options.headers);

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

async function revalidateResponseTags(tags: string[]): Promise<void> {
  if (tags.length === 0 || typeof window !== 'undefined') {
    return;
  }

  const { revalidateTag } = await import('next/cache');

  for (const tag of tags) {
    revalidateTag(tag);
  }
}

/**
 * Fetches the Fastify API through the frontend proxy contract.
 *
 * The backend owns app data and returns stable JSON error envelopes:
 * `{ error: { code, message, details? } }`. Successful mutation responses may
 * include `x-cache-tags`; when called on the server, those tags are passed to
 * Next.js `revalidateTag()`. Current binding: `PATCH /api/me/profile` emits
 * `profile,leaderboard`, matching `API_CACHE_TAGS_BY_ENDPOINT`.
 */
export async function apiFetchWithMeta<T>(
  path: string,
  options: FetchOptions = {},
): Promise<ApiFetchMeta<T>> {
  const response = await fetch(buildApiUrl(path), {
    ...options,
    credentials: options.credentials ?? 'include',
    headers: mergeHeaders(options),
  });

  if (!response.ok) {
    throw await readError(response);
  }

  const cacheTags = parseCacheTags(response.headers);
  await revalidateResponseTags(cacheTags);

  return {
    data: await parseJsonResponse<T>(response),
    status: response.status,
    headers: response.headers,
    cacheStatus: response.headers.get('x-tokensrank-cache'),
    cacheTags,
  };
}

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const response = await apiFetchWithMeta<T>(path, options);

  return response.data;
}

export {
  generateAccessKeyMutation,
  revokeAccessKeyMutation,
  updateProfileMutation,
  type GenerateAccessKeyMutationResponse,
  type RevokeAccessKeyMutationResponse,
  type UpdateProfileResponse,
} from './profile';
