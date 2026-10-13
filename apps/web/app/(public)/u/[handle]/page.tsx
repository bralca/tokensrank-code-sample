import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Suspense } from 'react';

import {
  HandleSchema,
  ProfileResponseSchema,
  ProfileWindowSchema,
  type ProfileResponse,
  type ProfileWindow,
} from '../../../../../../packages/shared/src';
import { ApiFetchError, apiFetchWithMeta } from '../../../../lib/api';
import { ProfileSkeleton } from '../../../../components/profile-skeleton';
// 5-Chapter design (Observable Plot charts + the Shipped chapter).
import { ProfileContainer } from '../../../components/profile/ProfileContainer';

type SearchParams = Record<string, string | string[] | undefined>;

type ProfilePageProps = {
  params: Promise<{ handle: string }>;
  searchParams?: Promise<SearchParams>;
};

type LoadedProfile = {
  profile: ProfileResponse;
  cacheStatus: string | null;
};

type ProfileVariantState = {
  isOwner: boolean;
  shareProjects: boolean;
  variant: ProfileResponse['variant'];
};

const sectionClassName = 'max-w-full overflow-hidden rounded-lg border border-tr-border bg-tr-bg-soft p-2 md:p-4';
const publicSiteUrl = 'https://tokensrank.ai';

class ProfileNotFoundError extends Error {
  public readonly code = 'profile_not_found';
  public readonly status = 404;

  public constructor(handle: string) {
    super(`profile_not_found:${handle}`);
    this.name = 'ProfileNotFoundError';
  }
}

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/u, '');
}

function profilePath(handle: string, window: ProfileWindow): string {
  if (window === 'all') {
    return `/u/${encodeURIComponent(handle)}`;
  }

  return `/u/${encodeURIComponent(handle)}?window=${encodeURIComponent(window)}`;
}

function profileApiPath(handle: string, window: ProfileWindow): string {
  return `/api/profile/${encodeURIComponent(handle)}?window=${encodeURIComponent(window)}`;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseHandle(rawHandle: string): string | null {
  const parsed = HandleSchema.safeParse(rawHandle.trim().toLowerCase());

  return parsed.success ? parsed.data : null;
}

function parseWindow(searchParams: SearchParams): ProfileWindow {
  const parsed = ProfileWindowSchema.safeParse(firstQueryValue(searchParams.window) ?? 'all');

  return parsed.success ? parsed.data : 'all';
}

function formatTokens(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));
  const formats = [
    { value: 1_000_000_000, suffix: 'B' },
    { value: 1_000_000, suffix: 'M' },
    { value: 1_000, suffix: 'K' },
  ] as const;

  for (const format of formats) {
    if (normalized >= format.value) {
      const amount = normalized / format.value;
      return `${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1)}${format.suffix}`;
    }
  }

  return String(normalized);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function getProfileVariantState(profile: ProfileResponse): ProfileVariantState {
  return {
    isOwner: profile.user_is_owner,
    shareProjects: profile.identity.share_projects,
    variant: profile.variant,
  };
}

async function authCookieHeader(): Promise<string | undefined> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('tr_at')?.value;

  return accessToken ? `tr_at=${encodeURIComponent(accessToken)}` : undefined;
}

async function loadProfile(handle: string, window: ProfileWindow): Promise<LoadedProfile | null> {
  const cookieHeader = await authCookieHeader();

  try {
    const response = await apiFetchWithMeta<unknown>(profileApiPath(handle, window), {
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      // Authenticated requests bypass the shared cache: the response carries
      // owner-only fields (and the owner's own live data), which must not be
      // cached under a viewer-agnostic key and served to other visitors.
      ...(cookieHeader
        ? { cache: 'no-store' as const }
        : { next: { revalidate: 60, tags: ['profile', `profile:${handle}:${window}`] } }),
    });

    return {
      profile: ProfileResponseSchema.parse(response.data),
      cacheStatus: response.cacheStatus,
    };
  } catch (error) {
    if (error instanceof ApiFetchError && error.status === 404) {
      return null;
    }

    console.warn('[web] Failed to load profile page data', {
      error,
      handle,
      window,
    });

    throw error;
  }
}

export async function generateMetadata({ params, searchParams }: ProfilePageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const resolvedSearchParams = await Promise.resolve(searchParams ?? {});
  const handle = parseHandle(resolvedParams.handle);
  const window = parseWindow(resolvedSearchParams);

  if (!handle) {
    return {
      title: 'Profile not found — TokensRank',
    };
  }

  const loadedProfile = await loadProfile(handle, window);

  if (!loadedProfile) {
    return {
      title: 'Profile not found — TokensRank',
    };
  }

  const { profile } = loadedProfile;
  const displayName = profile.identity.display_name?.trim() || `@${profile.identity.handle}`;
  const tokens = formatTokens(profile.headline.tokens_total);
  const title = truncateText(`${displayName} — ${tokens} token usage — TokensRank`, 200);
  const description = truncateText(
    `${displayName} ranks on TokensRank with ${tokens} verified AI coding token usage.`,
    125,
  );
  const canonical = `${publicSiteUrl}${profilePath(profile.identity.handle, window)}`;
  const ogImage = `${siteUrl()}/og/u/${encodeURIComponent(profile.identity.handle)}.png?v=b`;

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      title,
      description,
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          type: 'image/png',
        },
      ],
      url: canonical,
      type: 'profile',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  };
}

async function ProfileContent({ handle, window }: { handle: string; window: ProfileWindow }) {
  // Verify profile exists with initial load
  const loadedProfile = await loadProfile(handle, window);

  if (!loadedProfile) {
    throw new ProfileNotFoundError(handle);
  }

  return (
    <main className="dashboard">
      <ProfileContainer handle={handle} window={window} initialProfile={loadedProfile.profile} />
    </main>
  );
}

export default async function ProfilePage({ params, searchParams }: ProfilePageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = await Promise.resolve(searchParams ?? {});
  const handle = parseHandle(resolvedParams.handle);
  const window = parseWindow(resolvedSearchParams);

  if (!handle) {
    throw new ProfileNotFoundError(resolvedParams.handle);
  }

  return (
    <Suspense
      fallback={(
        <main className="dashboard">
          <ProfileSkeleton />
        </main>
      )}
    >
      <ProfileContent handle={handle} window={window} />
    </Suspense>
  );
}
