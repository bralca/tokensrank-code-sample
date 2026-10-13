import { AvatarWithBadge } from '../components/avatar-with-badge';
import { notFound } from 'next/navigation';

const tierBadge = {
  slug: 'tier',
  name: 'Tier',
  color_hex: '#FFB020',
};

const operatorBadge = {
  slug: 'operator',
  name: 'Operator',
  color_hex: '#00D084',
};

function svgAvatar(seed: string, fill: string): string {
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' fill='%23${fill}'/%3E%3Ctext x='48' y='56' text-anchor='middle' font-family='Arial' font-size='28' font-weight='700' fill='%230A0A0A'%3E${seed}%3C/text%3E%3C/svg%3E`;
}

export default function AvatarWithBadgeFixturePage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <main className="min-h-screen bg-tr-bg p-8 text-tr-text">
      <div className="flex flex-wrap items-start gap-10" data-testid="avatar-fixture-grid">
        <AvatarWithBadge
          avatar_url={svgAvatar('V', 'B6FF3C')}
          badges={[tierBadge]}
          handle="verified"
          mode="script_verified"
          size="medium"
        />
        <AvatarWithBadge
          avatar_url={svgAvatar('S', '848E9C')}
          badges={[operatorBadge]}
          handle="self"
          mode="self_reported"
          size="medium"
        />
        <AvatarWithBadge
          badges={[tierBadge]}
          handle="small"
          mode="script_verified"
          size="small"
        />
        <AvatarWithBadge
          badges={[tierBadge]}
          handle="large"
          mode="script_verified"
          size="large"
        />
        <AvatarWithBadge
          handle="noring"
          mode="self_reported"
          showBadgeRing={false}
          size="medium"
        />
      </div>
    </main>
  );
}
