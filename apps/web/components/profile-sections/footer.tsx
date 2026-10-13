import Link from 'next/link';

import type { ProfileResponse, ProfileVariant } from '../../../../packages/shared/src';

type ProfileFooterSectionProps = {
  profile: ProfileResponse;
  isOwner: boolean;
  variant: ProfileVariant;
  className?: string;
};

const staleSyncMs = 14 * 24 * 60 * 60 * 1000;

function isStaleScriptProfile(profile: ProfileResponse, isOwner: boolean): boolean {
  const lastSyncAt = profile.footer.owner?.last_sync_at ?? profile.last_sync_at ?? null;

  if (!isOwner || profile.identity.mode !== 'script_verified' || !lastSyncAt) {
    return false;
  }

  return new Date(lastSyncAt).getTime() < Date.now() - staleSyncMs;
}

function shareIntentUrl(profile: ProfileResponse): string {
  const rank = profile.headline.rank ? `#${profile.headline.rank}` : 'on';
  const text = `I ranked ${rank} TokensRank with ${profile.headline.tokens_total.toLocaleString('en-US')} AI coding tokens.`;

  return `https://twitter.com/intent/tweet?${new URLSearchParams({
    text,
    url: profile.footer.share_url,
  }).toString()}`;
}

export function ProfileFooterSection({
  profile,
  isOwner,
  variant,
  className = '',
}: ProfileFooterSectionProps) {
  const showStaleBanner = isStaleScriptProfile(profile, isOwner);

  return (
    <section
      aria-labelledby="profile-footer-heading"
      className={className}
      data-section="footer"
      data-variant={variant}
      data-testid="profile-section-footer"
    >
      <h2 id="profile-footer-heading" className="sr-only">
        Profile actions
      </h2>

      {showStaleBanner ? (
        <div
          role="status"
          className="mb-2 rounded-lg border border-tr-warning/60 bg-tr-warning/10 px-2 py-2 text-sm text-tr-warning md:mb-4 md:px-4 md:py-3"
          data-testid="profile-stale-sync-banner"
        >
          <p className="font-semibold">Verification is stale.</p>
          <p className="mt-1 text-tr-warning">
            Run the TokensRank script again to refresh your verified status.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap md:mt-3">
            <Link
              href="/onboarding/waiting"
              className="inline-flex h-9 items-center justify-center rounded-full border border-tr-warning px-3 text-sm font-medium text-tr-warning focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-500 focus-visible:outline-offset-2 focus-visible:outline-accent-lime"
            >
              Refresh sync
            </Link>
            <Link
              href="/me/settings"
              className="inline-flex h-9 items-center justify-center rounded-full border border-tr-border px-3 text-sm font-medium text-tr-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-500 focus-visible:outline-offset-2 focus-visible:outline-accent-lime"
            >
              Connection settings
            </Link>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
        <a
          href={shareIntentUrl(profile)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-10 items-center justify-center rounded-full border border-tr-accent bg-tr-accent px-5 text-sm font-semibold text-tr-bg hover:bg-[#C8FF55] focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-500 focus-visible:outline-offset-2 focus-visible:outline-accent-lime"
          data-testid="profile-share-button"
        >
          Share rank
        </a>

        {isOwner ? (
          <Link
            href="/me/settings"
            className="inline-flex h-10 items-center justify-center rounded-full border border-tr-border px-5 text-sm font-semibold text-tr-text hover:border-tr-accent hover:text-tr-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-500 focus-visible:outline-offset-2 focus-visible:outline-accent-lime"
          >
            Settings
          </Link>
        ) : null}
      </div>
    </section>
  );
}
