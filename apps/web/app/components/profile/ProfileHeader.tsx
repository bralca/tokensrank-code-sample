'use client';

import Link from 'next/link';
import { TR, LAYOUT, SPACING, FONT_MONO } from '@/lib/design-tokens';
import { TRWordmark } from '@/components/primitives/TRWordmark';

interface ProfileHeaderProps {
  handle: string;
  isOwner?: boolean;
}

export function ProfileHeader({ handle, isOwner = false }: ProfileHeaderProps) {
  return (
    <>
      {/* Top navigation bar */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${SPACING.md}px ${LAYOUT.contentPadding}px`,
          borderBottom: `1px solid ${TR.border}`,
          background: TR.bg,
        }}
      >
        {/* Left: Wordmark + Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
          <TRWordmark size={15} />
          <nav
            style={{
              display: 'flex',
              gap: 24,
              fontSize: 13.5,
            }}
          >
            <Link
              href="/"
              style={{
                color: TR.textMid,
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              Leaderboard
            </Link>
            <a
              href="#"
              style={{
                color: TR.textMid,
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              Badges
            </a>
            <a
              href="#"
              style={{
                color: TR.textMid,
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              Methodology
            </a>
          </nav>
        </div>

        {/* Right: Settings or Follow button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {isOwner ? (
            <>
              <button
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 14px',
                  fontSize: 12.5,
                  fontWeight: 500,
                  background: TR.bgSoft,
                  color: TR.text,
                  border: `1px solid ${TR.borderHi}`,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  borderRadius: 8,
                }}
              >
                Settings
              </button>
              <button
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 14px',
                  fontSize: 12.5,
                  fontWeight: 600,
                  background: TR.text,
                  color: TR.bg,
                  border: `1px solid ${TR.text}`,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  borderRadius: 8,
                }}
              >
                <svg width={11} height={11} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                <span>Share rank</span>
              </button>
            </>
          ) : (
            <button
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 14px',
                fontSize: 12.5,
                fontWeight: 500,
                background: TR.bgSoft,
                color: TR.text,
                border: `1px solid ${TR.borderHi}`,
                cursor: 'pointer',
                fontFamily: 'inherit',
                borderRadius: 8,
              }}
            >
              <svg width={11} height={11} viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              <span>Follow on X</span>
            </button>
          )}
        </div>
      </header>

      {/* Breadcrumb */}
      <div
        style={{
          padding: `${SPACING.sm}px ${LAYOUT.contentPadding}px`,
          fontSize: 12,
          color: TR.textMid,
          borderBottom: `1px solid ${TR.border}`,
          background: TR.bg,
        }}
      >
        <Link
          href="/"
          style={{
            color: TR.textMid,
            textDecoration: 'none',
          }}
        >
          Leaderboard
        </Link>
        <span style={{ margin: '0 8px', color: TR.textDim }}>/</span>
        <span style={{ color: TR.text }}>@{handle}</span>
        {isOwner && (
          <span
            style={{
              marginLeft: 12,
              color: TR.accent,
              fontSize: 11,
              fontFamily: FONT_MONO,
              fontWeight: 500,
            }}
          >
            ● your profile
          </span>
        )}
      </div>
    </>
  );
}
