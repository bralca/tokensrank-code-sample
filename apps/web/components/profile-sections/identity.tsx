import type { ProfileMode, ProfileVariant } from '../../../../packages/shared/src';
import { AvatarWithBadge } from '../../app/components/avatar-with-badge';

type IdentitySectionProps = {
  handle: string;
  display_name: string | null;
  bio: string | null;
  x_handle: string | null;
  avatar_url: string | null;
  mode: ProfileMode;
  badges?: Array<{ slug: string; name?: string; color?: string; color_hex?: string }>;
  variant: ProfileVariant;
  className?: string;
};

function displayNameFor(handle: string, displayName: string | null): string {
  return displayName?.trim() || handle;
}

function xHandleHref(xHandle: string): string {
  const normalized = xHandle.trim().replace(/^@/u, '');

  return `https://x.com/${encodeURIComponent(normalized)}`;
}

function xHandleLabel(xHandle: string): string {
  const normalized = xHandle.trim().replace(/^@/u, '');

  return `@${normalized}`;
}

function modeText(mode: ProfileMode): string {
  return mode === 'script_verified' ? 'Script verified' : 'Self-reported';
}

export function IdentitySection({
  handle,
  display_name,
  bio,
  x_handle,
  avatar_url,
  mode,
  badges = [],
  variant,
  className = '',
}: IdentitySectionProps) {
  const displayName = displayNameFor(handle, display_name);

  return (
    <section
      aria-labelledby="profile-identity-heading"
      className={[
        className,
        'flex min-w-0 flex-col items-start gap-2 md:flex-row md:items-center md:gap-4',
      ].join(' ')}
      data-section="identity"
      data-variant={variant}
      data-testid="profile-section-identity"
    >
      <AvatarWithBadge
        avatar_url={avatar_url}
        badges={badges}
        className="!h-16 !w-16 md:!h-24 md:!w-24"
        handle={handle}
        mode={mode ?? 'self_reported'}
        size="medium"
      />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1
            id="profile-identity-heading"
            className="min-w-0 break-words text-2xl font-semibold leading-tight text-tr-text md:text-3xl"
          >
            {displayName}
          </h1>
          <span className="rounded-full border border-tr-border px-2 py-1 text-xs font-medium text-tr-secondary">
            {modeText(mode)}
          </span>
        </div>

        <p className="mt-1 break-all font-mono text-xs text-tr-secondary md:text-sm">
          /u/{handle}
        </p>

        {bio ? (
          <p
            className="mt-2 max-w-full overflow-hidden text-sm leading-6 text-tr-secondary md:mt-3 md:max-w-3xl"
            style={{
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
            }}
          >
            {bio}
          </p>
        ) : null}

        {x_handle ? (
          <a
            href={xHandleHref(x_handle)}
            className="mt-2 inline-flex min-h-10 max-w-full items-center truncate text-sm font-medium text-tr-text underline decoration-tr-dim underline-offset-4 hover:text-tr-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-500 focus-visible:outline-offset-2 focus-visible:outline-accent-lime md:mt-3"
            rel="noreferrer"
            target="_blank"
          >
            {xHandleLabel(x_handle)}
          </a>
        ) : null}
      </div>
    </section>
  );
}
