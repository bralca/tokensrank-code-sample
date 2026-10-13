export const RESERVED_HANDLES = [
  'admin',
  'api',
  'app',
  'auth',
  'assets',
  'cdn',
  'contact',
  'dashboard',
  'feedback',
  'ftp',
  'help',
  'leaderboard',
  'mail',
  'me',
  'og',
  'onboarding',
  'profile',
  'root',
  'search',
  'settings',
  'sign-in',
  'sign-up',
  'smtp',
  'status',
  'support',
  'www',
] as const;

export const RESERVED_HANDLES_ARRAY = RESERVED_HANDLES;

export const RESERVED_HANDLES_SET = new Set<string>(RESERVED_HANDLES);

export type ReservedHandle = (typeof RESERVED_HANDLES)[number];

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES_SET.has(handle.trim().toLowerCase());
}
