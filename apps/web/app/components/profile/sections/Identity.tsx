'use client';

import { TR, LAYOUT, SPACING, FONT_MONO } from '@/lib/design-tokens';
import { AvatarWithBadge } from '@/components/primitives/AvatarWithBadge';
import { VerifyBadge } from '@/components/primitives/VerifyBadge';

interface IdentityProps {
  name: string;
  handle: string;
  avatarUrl?: string;
  mode?: 'verified' | 'self';
  os?: 'mac' | 'linux' | 'windows';
  joined: string;
  archetype?: string;
  lastSync?: string;
  lastSyncStatus?: 'live' | 'stale';
}

const osMonogramMap: Record<string, string> = {
  mac: '⌘',
  linux: 'L',
  windows: '⊞',
};

export function Identity({
  name,
  handle,
  avatarUrl,
  mode = 'verified',
  os = 'mac',
  joined,
  archetype = 'The Refactorer',
  lastSync = '2h ago',
  lastSyncStatus = 'live',
}: IdentityProps) {
  return (
    <section
      style={{
        padding: `${SPACING['2xl']}px 0 ${SPACING.xl}px`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 20,
        }}
      >
        {/* Avatar with badge */}
        <AvatarWithBadge src={avatarUrl} size={72} mode={mode} />

        {/* Identity info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Name + Handle + Badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 12,
            }}
          >
            <h1
              style={{
                fontSize: 26,
                fontWeight: 600,
                margin: 0,
                letterSpacing: '-0.02em',
                color: TR.text,
              }}
            >
              {name}
            </h1>

            {/* X Handle */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                color: TR.textMid,
              }}
            >
              <svg
                width={11}
                height={11}
                viewBox="0 0 24 24"
                fill="currentColor"
                style={{ flexShrink: 0 }}
              >
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 13.5,
                  fontWeight: 400,
                }}
              >
                @{handle}
              </span>
            </div>

            {/* Verification badge */}
            <VerifyBadge mode={mode} display="pill" />
          </div>

          {/* Metadata line: OS · joined · archetype */}
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              color: TR.textMid,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            {/* OS */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  border: `1px solid ${TR.border}`,
                  fontSize: 10,
                  fontFamily: FONT_MONO,
                  color: TR.textMid,
                }}
              >
                {osMonogramMap[os] || '·'}
              </span>
              <span>{os}</span>
            </span>

            {/* Separator */}
            <span style={{ color: TR.textDim }}>·</span>

            {/* Joined */}
            <span>joined {joined}</span>

            {/* Separator */}
            <span style={{ color: TR.textDim }}>·</span>

            {/* Archetype */}
            <span>{archetype}</span>

            {/* Live indicator if applicable */}
            {lastSyncStatus === 'live' && (
              <>
                <span style={{ color: TR.textDim }}>·</span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    color: TR.accent,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: TR.accent,
                      display: 'inline-block',
                      animation: 'tr-pulse 2s ease-in-out infinite',
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.14em',
                      fontWeight: 500,
                    }}
                  >
                    live
                  </span>
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
