import type { FastifyReply } from 'fastify';

export const ACCESS_TOKEN_COOKIE_NAME = 'tr_at';
export const REFRESH_TOKEN_COOKIE_NAME = 'tr_rt';
export const ACCESS_TOKEN_MAX_AGE_SECONDS = 60 * 60;
export const REFRESH_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const ACCESS_TOKEN_COOKIE_PATH = '/';
export const REFRESH_TOKEN_COOKIE_PATH = '/api/auth/refresh';
export const AUTH_COOKIE_DOMAIN = '.tokensrank.ai';

export type CookieName = typeof ACCESS_TOKEN_COOKIE_NAME | typeof REFRESH_TOKEN_COOKIE_NAME;

export interface CookieOptions {
  domain?: string;
  httpOnly: true;
  maxAge: number;
  path: string;
  sameSite: 'Lax';
  secure: true;
}

export type AuthCookieOptions = CookieOptions;

type CookieKind = 'access' | 'refresh';

type AuthCookieInput = {
  accessToken: string;
  refreshToken: string;
};

function cookieDomain(nodeEnv = process.env.NODE_ENV): string | undefined {
  return nodeEnv === 'production' ? AUTH_COOKIE_DOMAIN : undefined;
}

function kindForCookieName(type: CookieName): CookieKind {
  return type === ACCESS_TOKEN_COOKIE_NAME ? 'access' : 'refresh';
}

export function getCookieConfig(type: CookieName, nodeEnv = process.env.NODE_ENV): CookieOptions {
  const kind = kindForCookieName(type);

  return {
    ...(cookieDomain(nodeEnv) ? { domain: AUTH_COOKIE_DOMAIN } : {}),
    httpOnly: true,
    maxAge: kind === 'access' ? ACCESS_TOKEN_MAX_AGE_SECONDS : REFRESH_TOKEN_MAX_AGE_SECONDS,
    path: kind === 'access' ? ACCESS_TOKEN_COOKIE_PATH : REFRESH_TOKEN_COOKIE_PATH,
    sameSite: 'Lax',
    secure: true,
  };
}

export function getCookieOptions(kind: CookieKind, nodeEnv = process.env.NODE_ENV): CookieOptions {
  return getCookieConfig(kind === 'access' ? ACCESS_TOKEN_COOKIE_NAME : REFRESH_TOKEN_COOKIE_NAME, nodeEnv);
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
  ];

  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }

  parts.push('HttpOnly', 'Secure', `SameSite=${options.sameSite}`);

  return parts.join('; ');
}

function setCookieHeaders(reply: FastifyReply, headers: string[]): void {
  const existingHeader = reply.getHeader('Set-Cookie');
  const existingHeaders = Array.isArray(existingHeader)
    ? existingHeader.map(String)
    : existingHeader
      ? [String(existingHeader)]
      : [];

  reply.header('Set-Cookie', [...existingHeaders, ...headers]);
}

export function setAccessTokenCookie(reply: FastifyReply, accessToken: string): void {
  setCookieHeaders(reply, [
    serializeCookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, getCookieConfig(ACCESS_TOKEN_COOKIE_NAME)),
  ]);
}

export function setRefreshTokenCookie(reply: FastifyReply, refreshToken: string): void {
  setCookieHeaders(reply, [
    serializeCookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, getCookieConfig(REFRESH_TOKEN_COOKIE_NAME)),
  ]);
}

export function setCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void;
export function setCookies(reply: FastifyReply, input: AuthCookieInput): void;
export function setCookies(
  reply: FastifyReply,
  inputOrAccessToken: AuthCookieInput | string,
  refreshToken?: string,
): void {
  const input = typeof inputOrAccessToken === 'string'
    ? { accessToken: inputOrAccessToken, refreshToken: refreshToken ?? '' }
    : inputOrAccessToken;

  setCookieHeaders(reply, [
    serializeCookie(ACCESS_TOKEN_COOKIE_NAME, input.accessToken, getCookieConfig(ACCESS_TOKEN_COOKIE_NAME)),
    serializeCookie(REFRESH_TOKEN_COOKIE_NAME, input.refreshToken, getCookieConfig(REFRESH_TOKEN_COOKIE_NAME)),
  ]);
}

export function clearCookies(reply: FastifyReply): void {
  const accessOptions = {
    ...getCookieConfig(ACCESS_TOKEN_COOKIE_NAME),
    maxAge: 0,
  };
  const refreshOptions = {
    ...getCookieConfig(REFRESH_TOKEN_COOKIE_NAME),
    maxAge: 0,
  };

  setCookieHeaders(reply, [
    serializeCookie(ACCESS_TOKEN_COOKIE_NAME, '', accessOptions),
    serializeCookie(REFRESH_TOKEN_COOKIE_NAME, '', refreshOptions),
  ]);
}
