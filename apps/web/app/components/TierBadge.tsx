import Image from 'next/image';
import type { CSSProperties } from 'react';
import type { BadgeDefinition } from '../../../../packages/shared/src/schemas/badges';

export type TierBadgeSize = 'sm' | 'md' | 'lg';

export type TierBadgeBadge = Pick<BadgeDefinition, 'slug' | 'name' | 'icon_url' | 'color_hex'>;

export interface TierBadgeProps {
  badge: TierBadgeBadge;
  size?: TierBadgeSize;
  showLabel?: boolean;
  ariaLabel?: string;
  className?: string;
}

const SIZE_STYLES: Record<TierBadgeSize, { height: number; icon: number; paddingX: number; fontSize: number }> = {
  sm: { height: 24, icon: 14, paddingX: 7, fontSize: 10 },
  md: { height: 30, icon: 16, paddingX: 9, fontSize: 11 },
  lg: { height: 36, icon: 20, paddingX: 11, fontSize: 12 },
};

function classNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function hexToRgba(hex: string, alpha: number): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function isHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/u.test(color);
}

type TierBadgeStyle = CSSProperties & {
  '--tier-badge-hover-bg': string;
};

export default function TierBadge({
  badge,
  size = 'md',
  showLabel = false,
  ariaLabel,
  className,
}: TierBadgeProps) {
  const sizeStyle = SIZE_STYLES[size];
  const color = isHexColor(badge.color_hex) ? badge.color_hex : '#B6FF3C';
  const label = ariaLabel ?? badge.name;
  const badgeStyle: TierBadgeStyle = {
    backgroundColor: hexToRgba(color, 0.1),
    borderColor: color,
    color,
    fontSize: sizeStyle.fontSize,
    height: sizeStyle.height,
    paddingLeft: sizeStyle.paddingX,
    paddingRight: sizeStyle.paddingX,
    '--tier-badge-hover-bg': hexToRgba(color, 0.2),
  };

  return (
    <span
      aria-label={label}
      className={classNames(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border font-mono font-semibold uppercase tracking-[0.1em] transition-colors hover:bg-[var(--tier-badge-hover-bg)]',
        className,
      )}
      data-color={color}
      data-testid="tier-badge"
      style={badgeStyle}
      title={badge.name}
    >
      <span className="relative inline-flex shrink-0" style={{ height: sizeStyle.icon, width: sizeStyle.icon }}>
        {badge.icon_url ? (
          <Image
            alt=""
            height={sizeStyle.icon}
            src={badge.icon_url}
            unoptimized
            width={sizeStyle.icon}
          />
        ) : (
          <span
            aria-hidden="true"
            className="inline-block rounded-full"
            style={{
              backgroundColor: color,
              height: sizeStyle.icon,
              width: sizeStyle.icon,
            }}
          />
        )}
      </span>
      {showLabel ? <span className="whitespace-nowrap">{badge.name}</span> : null}
    </span>
  );
}
