import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { OnboardingScriptInstall } from '../../../components/onboarding-script-install';
import { OnboardingSelfReported } from '../../../components/onboarding-self-reported';
import { getApiBaseUrl } from '../../../lib/api';
import type { OnboardingWaitingSearchParams } from '../../../lib/types/onboarding';
import type {
  GeneratedOnboardingAccessKey,
  OnboardingAccessKey,
  OnboardingMe,
  OnboardingMode,
} from '../../../lib/types/onboarding';

type OnboardingWaitingPageProps = {
  searchParams?: Promise<OnboardingWaitingSearchParams>;
};

type MeApiResponse = {
  data: OnboardingMe;
};

type GenerateAccessKeyApiResponse = {
  data: GeneratedOnboardingAccessKey;
};

function normalizeMode(mode: OnboardingWaitingSearchParams['mode']) {
  return Array.isArray(mode) ? mode[0] : mode;
}

function isOnboardingMode(value: string | undefined): value is OnboardingMode {
  return value === 'script' || value === 'self_reported';
}

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

function findActiveAccessKey(accessKeys: OnboardingAccessKey[], mode: OnboardingMode) {
  return accessKeys.find((key) => key.scope === mode && !key.revokedAt) ?? null;
}

async function loadCurrentUser(cookieHeader: string): Promise<OnboardingMe | null> {
  const response = await fetch(`${getApiBaseUrl()}/api/me`, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Cookie: cookieHeader,
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

async function generateAccessKey(cookieHeader: string, mode: OnboardingMode, e2eUser: OnboardingMe | null) {
  if (e2eUser && process.env.NODE_ENV !== 'production') {
    const prefix = mode === 'script' ? 'tr_script_e2' : 'tr_self_rep';

    return {
      id: '00000000-0000-4000-8000-000000000059',
      scope: mode,
      prefix,
      plaintext: `${mode === 'script' ? 'tr_script_' : 'tr_self_reported_'}abcdefghijklmnopqrstuvwxyz123456`.slice(
        0,
        mode === 'script' ? 42 : 49,
      ),
      created_at: '2026-04-28T00:00:00.000Z',
    };
  }

  const response = await fetch(`${getApiBaseUrl()}/api/access-keys/generate`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
    },
    body: JSON.stringify({ scope: mode }),
  });

  if (!response.ok) {
    return null;
  }

  const body = await response.json() as GenerateAccessKeyApiResponse;

  return body.data;
}

function ErrorPanel({ title, message }: { title: string; message: string }) {
  return (
    <div
      className="rounded-md border border-[#b91c1c]/50 bg-[#b91c1c]/10 p-5 text-sm leading-6 text-[#b91c1c]"
      role="alert"
      data-testid="onboarding-error"
    >
      <p className="font-sans text-sm font-medium text-[#b91c1c]">
        {title}
      </p>
      <p className="mt-2">{message}</p>
      <a className="mt-4 inline-flex text-[var(--ink)] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" href="/onboarding">
        Return to mode selection
      </a>
    </div>
  );
}

export default async function OnboardingWaitingPage({ searchParams }: OnboardingWaitingPageProps) {
  const resolvedSearchParams = await Promise.resolve<OnboardingWaitingSearchParams>(searchParams ?? {});
  const mode = normalizeMode(resolvedSearchParams.mode);

  if (!isOnboardingMode(mode)) {
    return (
      <section className="flex w-full flex-col gap-8" aria-labelledby="onboarding-waiting-title">
        <header className="flex flex-col gap-3">
          <p className="font-sans text-sm font-medium text-[var(--accent-ink)]">
            Step 02 / Setup
          </p>
          <h1 id="onboarding-waiting-title" className="max-w-2xl text-3xl font-semibold text-[var(--ink)] sm:text-4xl">
            Complete your connection.
          </h1>
        </header>

        <ErrorPanel
          title="Invalid mode"
          message="Choose VERIFIED or SELF-REPORTED before opening this setup page."
        />
      </section>
    );
  }

  const cookieStore = await cookies();
  const cookieHeader = buildCookieHeader(cookieStore);
  const e2eUser = readE2eUser(cookieStore);
  const currentUser = e2eUser ?? await loadCurrentUser(cookieHeader);

  if (!currentUser) {
    redirect('/auth/sign-in');
  }

  if (!currentUser.handle) {
    return (
      <section className="flex w-full flex-col gap-8" aria-labelledby="onboarding-waiting-title">
        <header className="flex flex-col gap-3">
          <p className="font-sans text-sm font-medium text-[var(--accent-ink)]">
            Step 02 / Setup
          </p>
          <h1 id="onboarding-waiting-title" className="max-w-2xl text-3xl font-semibold text-[var(--ink)] sm:text-4xl">
            Complete your connection.
          </h1>
        </header>

        <ErrorPanel
          title="Missing handle"
          message="Your profile is still being created. Return to onboarding and try again."
        />
      </section>
    );
  }

  const activeAccessKey = findActiveAccessKey(currentUser.accessKeys, mode);
  const shouldGenerateOnServer = mode === 'self_reported' || Boolean(e2eUser);
  const generatedAccessKey = activeAccessKey || !shouldGenerateOnServer
    ? null
    : await generateAccessKey(cookieHeader, mode, e2eUser);
  const plaintextAccessKey = generatedAccessKey?.plaintext ?? null;

  return (
    <section className="flex w-full flex-col gap-8" aria-labelledby="onboarding-waiting-title">
      <header className="flex flex-col gap-3">
        <p className="font-sans text-sm font-medium text-[var(--accent-ink)]">
          Step 02 / {mode === 'self_reported' ? 'Self-reported' : 'Verified'}
        </p>
        <h1 id="onboarding-waiting-title" className="max-w-2xl text-3xl font-semibold text-[var(--ink)] sm:text-4xl">
          Complete your connection.
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-[var(--muted)]">
          {mode === 'script'
            ? 'Install the script and keep this page open for live detection.'
            : 'Copy the endpoint, bearer token, and JSON template for manual ingestion.'}
        </p>
      </header>

      {mode === 'script' ? (
        <OnboardingScriptInstall
          handle={currentUser.handle}
          generatedAccessKey={generatedAccessKey}
          shouldGenerateAccessKey={!activeAccessKey && !generatedAccessKey}
        />
      ) : plaintextAccessKey ? (
        <OnboardingSelfReported accessKey={plaintextAccessKey} handle={currentUser.handle} />
      ) : (
        <ErrorPanel
          title="Access key unavailable"
          message="A self-reported key already exists or could not be generated, so the plaintext bearer token cannot be shown again."
        />
      )}
    </section>
  );
}
