'use client';

import { useEffect, useState } from 'react';

import { avatarProxyUrl } from '../lib/avatar-url';

export const ACCENT_LIME = '#B6FF3C';
export const DARK_BG = '#0A0A0A';

export type AvatarVerificationMode = 'script_verified' | 'self_reported';
export type AvatarMode = AvatarVerificationMode | null;
export type AvatarSize = 'small' | 'medium' | 'large';

export type AvatarBadge = {
  slug: string;
  name?: string;
  color?: string;
  color_hex?: string;
};

/**
 * Props for the mandatory avatar primitive used anywhere a profile avatar is
 * rendered. The component must expose non-color-only verification state through
 * a shaped pip with an aria-label, and avatar images must use
 * `alt="avatar for {handle}"` so screen readers receive the same identity and
 * verification context sighted users get from the pip.
 */
export interface AvatarWithBadgeProps {
  handle: string;
  mode: AvatarMode;
  avatar_url?: string | null;
  badges?: AvatarBadge[];
  size?: AvatarSize;
  showBadgeRing?: boolean;
  className?: string;
}

const NEUTRAL_PIP = '#848E9C';
const SIZE_PIXELS: Record<AvatarSize, number> = {
  small: 64,
  medium: 96,
  large: 128,
};

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function fallbackInitial(handle: string): string {
  const normalized = handle.trim();

  return (normalized.charAt(0) || '?').toUpperCase();
}

function verificationLabel(mode: AvatarMode): string | undefined {
  if (mode === 'script_verified') {
    return 'Verified via script';
  }

  if (mode === 'self_reported') {
    return 'Self-reported';
  }

  return undefined;
}

function verificationGlyph(mode: AvatarVerificationMode): string {
  return mode === 'script_verified' ? '✓' : '~';
}

function pipColor(mode: AvatarVerificationMode): string {
  return mode === 'script_verified' ? ACCENT_LIME : NEUTRAL_PIP;
}

function badgeColor(badges: AvatarBadge[]): string | null {
  const color = badges.find((badge) => badge.color_hex || badge.color)?.color_hex
    ?? badges.find((badge) => badge.color)?.color
    ?? null;

  if (!color || !/^#[0-9A-Fa-f]{6}$/u.test(color)) {
    return null;
  }

  return color;
}

/**
 * Mandatory avatar primitive with verification pip and optional earned-badge
 * ring. Use this instead of bare avatar images so visual verification state is
 * always paired with accessible text.
 */
export function AvatarWithBadge({
  handle,
  mode,
  avatar_url = null,
  badges = [],
  size = 'medium',
  showBadgeRing = true,
  className,
}: AvatarWithBadgeProps) {
  const pixelSize = SIZE_PIXELS[size];
  const ringColor = showBadgeRing ? badgeColor(badges) : null;
  const label = verificationLabel(mode);
  const imageUrl = avatarProxyUrl(avatar_url);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);

  return (
    <span
      aria-label={label}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full bg-tr-bg-soft font-semibold text-tr-text',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-500 focus-visible:outline-offset-2 focus-visible:outline-accent-lime',
        'group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-lime-500 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent-lime',
        className,
      )}
      data-size={size}
      data-testid="avatar-with-badge"
      role={label ? 'group' : undefined}
      style={{ height: pixelSize, width: pixelSize }}
    >
      {ringColor ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full border-[1px]"
          data-testid="avatar-badge-ring"
          style={{ borderColor: ringColor }}
        />
      ) : null}

      {imageUrl && !imageFailed ? (
        <img
          alt={`avatar for ${handle}`}
          className="h-full w-full rounded-full object-cover"
          data-original-src={avatar_url ?? undefined}
          data-testid="avatar-image"
          onError={() => setImageFailed(true)}
          src={imageUrl}
        />
      ) : (
        <span
          aria-label={`avatar for ${handle}`}
          className="flex h-full w-full items-center justify-center rounded-full border border-tr-border bg-tr-bg-soft font-mono text-[36px] leading-none text-tr-text"
          data-testid="avatar-fallback"
          role="img"
        >
          {fallbackInitial(handle)}
        </span>
      )}

      {mode ? (
        <span
          aria-hidden="true"
          className="absolute bottom-0 right-0 flex items-center justify-center rounded-full border-2 font-mono font-bold leading-none shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          data-mode={mode}
          data-testid="avatar-verification-pip"
          style={{
            backgroundColor: pipColor(mode),
            borderColor: DARK_BG,
            color: DARK_BG,
            fontSize: 12,
            height: 17,
            width: 17,
          }}
        >
          {verificationGlyph(mode)}
        </span>
      ) : null}
    </span>
  );
}
