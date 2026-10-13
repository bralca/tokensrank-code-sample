import { TR, FONT_MONO } from '@/lib/design-tokens';

interface VerifyBadgeProps {
  mode?: 'verified' | 'self';
  display?: 'pill' | 'label';
}

const badgeContent = {
  verified: {
    text: 'VERIFIED',
    bg: 'transparent',
    border: `1px solid ${TR.accent}`,
    color: TR.accent,
  },
  self: {
    text: 'SELF-REPORTED',
    bg: 'transparent',
    border: `1px solid ${TR.textDim}`,
    color: TR.textDim,
  },
};

export function VerifyBadge({ mode = 'verified', display = 'pill' }: VerifyBadgeProps) {
  const badge = badgeContent[mode];

  if (display === 'label') {
    return (
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          fontWeight: 500,
          color: badge.color,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {badge.text}
      </span>
    );
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: 10,
        fontWeight: 500,
        fontFamily: FONT_MONO,
        background: badge.bg,
        border: badge.border,
        color: badge.color,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {badge.text}
    </div>
  );
}
