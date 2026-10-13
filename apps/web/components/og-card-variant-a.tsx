import { formatOGCost, formatOGTokens } from './og-card-format';
import type { OGCardProps } from './og-card-types';

const accentColor = '#b63b13';
const backgroundColor = '#fffdfb';
const mutedTextColor = '#746d65';

export function OGCardVariantA({ profile }: OGCardProps) {
  const rank = profile.rank ?? 1;
  const tokens = formatOGTokens(profile.total_tokens);
  const cost = formatOGCost(profile.cost_usd_total);
  const handleLabel = `@${profile.handle}`;
  const rankLabel = `#${rank}`;
  const tokenCostStatement = `${tokens} tokens · ${cost}`;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: backgroundColor,
        color: '#272421',
        fontFamily: 'Geist, Arial, sans-serif',
        padding: '60px',
      }}
    >
      <img
        src={profile.avatar_url}
        alt=""
        width="120"
        height="120"
        style={{
          width: '120px',
          height: '120px',
          borderRadius: '9999px',
          marginBottom: '20px',
          objectFit: 'cover',
        }}
      />
      <h2
        style={{
          display: 'flex',
          fontSize: '28pt',
          fontWeight: 600,
          lineHeight: 1.1,
          margin: 0,
        }}
      >
        {profile.display_name}
      </h2>
      <p
        style={{
          display: 'flex',
          fontSize: '18pt',
          color: mutedTextColor,
          lineHeight: 1.2,
          margin: '8px 0 20px',
        }}
      >
        {handleLabel}
      </p>
      <div
        style={{
          display: 'flex',
          fontSize: '36pt',
          color: accentColor,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {rankLabel}
      </div>
      <p
        style={{
          display: 'flex',
          fontSize: '20pt',
          lineHeight: 1.2,
          margin: '16px 0 0',
          color: '#272421',
        }}
      >
        {tokenCostStatement}
      </p>
      <div
        style={{
          display: 'flex',
          fontSize: '14pt',
          color: mutedTextColor,
          marginTop: '30px',
        }}
      >
        tokensrank.
      </div>
    </div>
  );
}
