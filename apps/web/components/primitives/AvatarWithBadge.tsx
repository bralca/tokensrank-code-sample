import { TR } from '@/lib/design-tokens';
import Image from 'next/image';

interface AvatarWithBadgeProps {
  src?: string;
  size?: number;
  mode?: 'verified' | 'self';
  tier?: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'diamond2';
}

const tierMap = {
  bronze: { rings: 1, color: '#B86E3C' },
  silver: { rings: 2, color: '#C8C8C8' },
  gold: { rings: 3, color: '#E0B83C' },
  platinum: { rings: 4, color: '#9EE0DA' },
  diamond: { rings: 5, color: '#A8D8FF' },
  diamond2: { rings: 6, color: TR.accent },
};

function TierRing({ tier = 'gold', size = 72 }: { tier: string; size: number }) {
  const t = tierMap[tier as keyof typeof tierMap] || tierMap.gold;
  const cx = size / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        display: 'block',
        position: 'absolute',
        top: 0,
        left: 0,
      }}
    >
      {Array.from({ length: t.rings }).map((_, i) => {
        const r = (size / 2 - 1) * (1 - i * (1 / (t.rings + 0.6)));
        return (
          <circle
            key={i}
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            stroke={t.color}
            strokeWidth={1}
          />
        );
      })}
      <circle cx={cx} cy={cx} r={1.2} fill={t.color} />
    </svg>
  );
}

export function AvatarWithBadge({
  src = 'https://i.pravatar.cc/120?img=1',
  size = 72,
  mode = 'verified',
  tier = 'gold',
}: AvatarWithBadgeProps) {
  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      {/* Tier ring background */}
      <TierRing tier={tier} size={size} />

      {/* Avatar image */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          borderRadius: '50%',
          overflow: 'hidden',
          backgroundColor: TR.bgSoft,
          border: `1px solid ${TR.border}`,
        }}
      >
        <Image
          src={src}
          alt="Avatar"
          width={size}
          height={size}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      </div>

      {/* Verification badge (small dot at bottom right) */}
      {mode === 'verified' && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: 14,
            height: 14,
            borderRadius: '50%',
            backgroundColor: TR.accent,
            border: `2px solid ${TR.bg}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            fontWeight: 600,
            color: TR.bg,
          }}
        >
          ✓
        </div>
      )}
    </div>
  );
}
