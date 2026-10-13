import { formatOGCost, formatOGTokens } from './og-card-format';
import type { OGCardProps } from './og-card-types';

const accentColor = '#b63b13';
const mutedTextColor = '#746d65';

export function OGCardVariantB({ profile }: OGCardProps) {
  const rank = profile.rank ?? 1;
  const tokens = formatOGTokens(profile.total_tokens);
  const cost = formatOGCost(profile.cost_usd_total);
  const handleLabel = `@${profile.handle}`;
  const tokenCostStatement = `${tokens} tokens · ${cost}`;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        background: '#fffdfb',
        color: '#272421',
        fontFamily: 'Geist, Arial, sans-serif',
        padding: '40px 60px',
        overflow: 'hidden',
      }}
    >
      <img
        src={profile.avatar_url}
        alt=""
        width="64"
        height="64"
        style={{
          position: 'absolute',
          top: '44px',
          right: '60px',
          width: '64px',
          height: '64px',
          borderRadius: '9999px',
          objectFit: 'cover',
        }}
      />
      <div
        style={{
          display: 'flex',
          fontSize: '600px',
          fontWeight: 700,
          color: accentColor,
          lineHeight: 0.8,
          marginLeft: '-100px',
          marginTop: '-150px',
          marginBottom: '-90px',
        }}
      >
        {rank}
      </div>
      <h2
        style={{
          display: 'flex',
          fontSize: '24pt',
          fontWeight: 600,
          lineHeight: 1,
          margin: '0 0 12px',
          color: '#272421',
        }}
      >
        {handleLabel}
      </h2>
      <p
        style={{
          display: 'flex',
          fontSize: '18pt',
          color: accentColor,
          fontWeight: 600,
          lineHeight: 1.2,
          margin: 0,
        }}
      >
        {tokenCostStatement}
      </p>
      <p
        style={{
          display: 'flex',
          fontSize: '14pt',
          color: mutedTextColor,
          lineHeight: 1.2,
          margin: '20px 0 0',
        }}
      >
        tokensrank.
      </p>
    </div>
  );
}
