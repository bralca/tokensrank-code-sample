import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getApiBaseUrl } from '../../lib/api';
import type { OnboardingMe } from '../../lib/types/onboarding';

type MeApiResponse = {
  data: OnboardingMe;
};

function buildCookieHeader(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  return cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
    .join('; ');
}

function readE2eUser(cookieStore: Awaited<ReturnType<typeof cookies>>): OnboardingMe | null {
  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  const rawValue = cookieStore.get('tr_e2e_onboarding')?.value;

  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(decodeURIComponent(rawValue)) as OnboardingMe;
  } catch (error) {
    console.warn('[web] Failed to parse onboarding E2E cookie', error);
    return null;
  }
}

async function loadCurrentUser(): Promise<OnboardingMe | null> {
  const cookieStore = await cookies();
  const e2eUser = readE2eUser(cookieStore);

  if (e2eUser) {
    return e2eUser;
  }

  const response = await fetch(`${getApiBaseUrl()}/api/me`, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Cookie: buildCookieHeader(cookieStore),
    },
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`[onboarding] Failed to load /api/me: ${response.status}`);
  }

  const body = await response.json() as MeApiResponse;

  return body.data;
}

export default async function OnboardingPage() {
  const currentUser = await loadCurrentUser();

  if (!currentUser) {
    redirect('/auth/sign-in');
  }

  if (currentUser.onboarding.step === 'complete' && currentUser.handle) {
    redirect('/me');
  }

  redirect('/join');
}
