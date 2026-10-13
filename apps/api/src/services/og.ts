import { createElement, type ReactElement } from 'react';
import { ImageResponse } from '@vercel/og';

import { adminClient } from '../clients/supabase';
import {
  buildProfileResponse,
  type ProfileResponseProfile,
} from './profile';

export type OGVariant = 'a' | 'b';

export type OGProfileCardData = {
  handle: string;
  displayName: string;
  rank: number | null;
  totalTokens: number;
  costUsd: number;
  mode: 'script_verified' | 'self_reported';
};

export class OGProfileNotFoundError extends Error {
  public constructor(handle: string) {
    super(`Profile not found for handle "${handle}"`);
    this.name = 'OGProfileNotFoundError';
  }
}

export class OGProfileLoadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OGProfileLoadError';
  }
}

export class OGRenderError extends Error {
  public readonly cause?: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OGRenderError';
    this.cause = cause;
  }
}

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;
const TR_BG = '#0A0A0A';
const TR_ELEV = '#111111';
const TR_BORDER = '#1F1F1F';
const TR_TEXT = '#F5F5F5';
const TR_TEXT_MID = '#9A9A9A';
const TR_TEXT_DIM = '#5C5C5C';
const TR_ACCENT = '#B6FF3C';
const TR_DOWN = '#FF5A5A';

function formatTokens(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));

  if (normalized >= 1_000_000_000) {
    return `${(normalized / 1_000_000_000).toFixed(1).replace(/\.0$/u, '')}B`;
  }

  if (normalized >= 1_000_000) {
    return `${(normalized / 1_000_000).toFixed(1).replace(/\.0$/u, '')}M`;
  }

  if (normalized >= 1_000) {
    return `${(normalized / 1_000).toFixed(1).replace(/\.0$/u, '')}K`;
  }

  return String(normalized);
}

function formatCost(value: number): string {
  return `$${Math.max(0, value).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function wordmark(): ReactElement {
  return createElement('div', {
    style: {
      display: 'flex',
      fontFamily: 'Geist, Arial, sans-serif',
      fontSize: 30,
      fontWeight: 600,
      letterSpacing: 0,
      color: TR_TEXT,
    },
  }, [
    createElement('span', { key: 'open', style: { color: TR_ACCENT } }, '['),
    'tokens',
    createElement('span', { key: 'dot', style: { color: TR_TEXT_DIM } }, '·'),
    'rank',
    createElement('span', { key: 'close', style: { color: TR_ACCENT } }, ']'),
  ]);
}

function verificationPill(mode: OGProfileCardData['mode']): ReactElement {
  const isVerified = mode === 'script_verified';

  return createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      height: 38,
      padding: '0 16px',
      borderRadius: 999,
      border: `1px solid ${isVerified ? TR_ACCENT : TR_BORDER}`,
      color: isVerified ? TR_ACCENT : TR_TEXT_MID,
      fontSize: 18,
      fontWeight: 600,
    },
  }, isVerified ? 'verified' : 'self-reported');
}

function metric(label: string, value: string): ReactElement {
  return createElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      width: 260,
      padding: 26,
      background: TR_ELEV,
      border: `1px solid ${TR_BORDER}`,
      borderRadius: 8,
    },
  }, [
    createElement('div', {
      key: 'label',
      style: {
        color: TR_TEXT_DIM,
        fontSize: 18,
        fontWeight: 600,
        letterSpacing: 1.6,
        textTransform: 'uppercase',
      },
    }, label),
    createElement('div', {
      key: 'value',
      style: {
        color: TR_TEXT,
        fontFamily: 'Geist, Arial, sans-serif',
        fontSize: 42,
        fontWeight: 600,
      },
    }, value),
  ]);
}

function initials(profile: OGProfileCardData): string {
  return profile.displayName
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || profile.handle.slice(0, 2).toUpperCase();
}

function avatar(profile: OGProfileCardData): ReactElement {
  return createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 132,
      height: 132,
      borderRadius: 999,
      background: TR_ACCENT,
      color: TR_BG,
      fontSize: 46,
      fontWeight: 700,
      border: `1px solid ${TR_ACCENT}`,
    },
  }, initials(profile));
}

function accentBars(): ReactElement {
  return createElement('div', {
    style: {
      display: 'flex',
      gap: 10,
      height: 90,
      alignItems: 'flex-end',
    },
  }, [34, 58, 82, 46, 70, 92, 64].map((height, index) => createElement('div', {
    key: `bar-${index}`,
    style: {
      width: 16,
      height,
      background: index % 2 === 0 ? TR_ACCENT : '#6A9926',
      borderRadius: 3,
    },
  })));
}

function baseCard(children: ReactElement[]): ReactElement {
  return createElement('div', {
    style: {
      display: 'flex',
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      background: TR_BG,
      color: TR_TEXT,
      fontFamily: 'Geist, Arial, sans-serif',
      padding: 56,
      position: 'relative',
      overflow: 'hidden',
    },
  }, children);
}

function variantA(profile: OGProfileCardData): ReactElement {
  const rank = profile.rank ? `#${profile.rank}` : '#--';

  return baseCard([
    createElement('div', {
      key: 'left',
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
      },
    }, [
      createElement('div', {
        key: 'top',
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        },
      }, [wordmark(), verificationPill(profile.mode)]),
      createElement('div', {
        key: 'hero',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 34,
        },
      }, [
        avatar(profile),
        createElement('div', {
          key: 'identity',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          },
        }, [
          createElement('div', {
            key: 'rank',
            style: {
              color: TR_ACCENT,
              fontSize: 78,
              fontWeight: 700,
              lineHeight: 0.95,
            },
          }, rank),
          createElement('div', {
            key: 'name',
            style: {
              color: TR_TEXT,
              fontSize: 54,
              fontWeight: 600,
            },
          }, profile.displayName),
          createElement('div', {
            key: 'handle',
            style: {
              color: TR_TEXT_MID,
              fontSize: 32,
            },
          }, `@${profile.handle}`),
        ]),
      ]),
      createElement('div', {
        key: 'bottom',
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
        },
      }, [
        createElement('div', {
          key: 'metrics',
          style: {
            display: 'flex',
            gap: 18,
          },
        }, [
          metric('Token usage', formatTokens(profile.totalTokens)),
          metric('Cost', formatCost(profile.costUsd)),
        ]),
        accentBars(),
      ]),
    ]),
  ]);
}

function variantB(profile: OGProfileCardData): ReactElement {
  const rank = profile.rank ? `#${profile.rank}` : '#--';

  return baseCard([
    createElement('div', {
      key: 'bleed-rank',
      style: {
        display: 'flex',
        position: 'absolute',
        right: -46,
        top: -118,
        color: TR_ACCENT,
        fontSize: 292,
        fontWeight: 700,
        lineHeight: 1,
        opacity: 0.96,
      },
    }, rank),
    createElement('div', {
      key: 'content',
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
      },
    }, [
      createElement('div', {
        key: 'top',
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingRight: 350,
        },
      }, [wordmark(), verificationPill(profile.mode)]),
      createElement('div', {
        key: 'headline',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          maxWidth: 780,
        },
      }, [
        createElement('div', {
          key: 'statement',
          style: {
            color: TR_TEXT,
            fontSize: 72,
            fontWeight: 700,
            lineHeight: 0.98,
          },
        }, `${profile.displayName} is climbing TokensRank`),
        createElement('div', {
          key: 'handle',
          style: {
            color: TR_TEXT_MID,
            fontSize: 34,
          },
        }, `@${profile.handle}`),
      ]),
      createElement('div', {
        key: 'bottom',
        style: {
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
        },
      }, [
        createElement('div', {
          key: 'metrics',
          style: {
            display: 'flex',
            gap: 18,
          },
        }, [
          metric('Token usage', formatTokens(profile.totalTokens)),
          metric('Cost', formatCost(profile.costUsd)),
        ]),
        createElement('div', {
          key: 'signal',
          style: {
            display: 'flex',
            color: TR_DOWN,
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: 1.6,
            textTransform: 'uppercase',
          },
        }, 'public proof of usage'),
      ]),
    ]),
  ]);
}

async function loadProfileRow(handle: string): Promise<ProfileResponseProfile> {
  const { data, error } = await adminClient
    .from('profiles')
    .select([
      'id',
      'user_id',
      'handle',
      'display_name',
      'avatar_url',
      'bio',
      'x_handle',
      'mode',
      'verified',
      'share_projects',
      'created_at',
    ].join(','))
    .ilike('handle', handle)
    .maybeSingle<ProfileResponseProfile>();

  if (error) {
    throw new OGProfileLoadError(`[og] Profile lookup failed: ${error.message}`);
  }

  if (!data) {
    throw new OGProfileNotFoundError(handle);
  }

  return data;
}

export async function loadProfileCardData(handle: string): Promise<OGProfileCardData> {
  const profileRow = await loadProfileRow(handle);

  try {
    const profile = await buildProfileResponse(profileRow, 'all', false);

    return {
      handle: profile.identity.handle,
      displayName: profile.identity.display_name ?? profile.identity.handle,
      rank: profile.headline.rank,
      totalTokens: profile.headline.tokens_total,
      costUsd: profile.headline.cost_usd_total,
      mode: profile.identity.mode ?? 'self_reported',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown profile response error';
    throw new OGProfileLoadError(`[og] Profile hydration failed: ${message}`);
  }
}

export async function renderProfileCard(
  profile: OGProfileCardData,
  variant: OGVariant,
): Promise<Buffer> {
  try {
    const response = new ImageResponse(variant === 'a' ? variantA(profile) : variantB(profile), {
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
    });

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown render error';
    throw new OGRenderError(`[og] Profile card render failed: ${message}`, {
      error,
    });
  }
}
