import { describe, expect, it } from 'vitest';

import { OGCardVariantA } from './og-card-variant-a';
import { collectElements, flattenText } from './og-card-test-utils';
import type { OGProfile } from './og-card-types';

const profile: OGProfile = {
  handle: 'alex',
  display_name: 'Alex Builder',
  total_tokens: 1_500_000,
  cost_usd_total: 12.34,
  avatar_url: 'https://example.com/avatar.png',
  mode: 'script_verified',
  rank: 7,
};

describe('OGCardVariantA', () => {
  it('renders required profile fields and accent color', () => {
    const element = OGCardVariantA({ profile });
    const text = flattenText(element);
    const elements = collectElements(element);
    const avatar = elements.find((item) => item.type === 'img');
    const accentElement = elements.find((item) => {
      const style = item.props.style as { color?: string } | undefined;
      return style?.color === '#b63b13';
    });

    expect(text).toContain('Alex Builder');
    expect(text).toContain('@alex');
    expect(text).toContain('#7');
    expect(text).toContain('1.5M tokens');
    expect(text).toContain('$12.34');
    expect(text).toContain('tokensrank.');
    expect(avatar?.props.src).toBe(profile.avatar_url);
    expect(accentElement).toBeDefined();
  });

  it('defaults missing rank to first place for share previews', () => {
    const text = flattenText(OGCardVariantA({ profile: { ...profile, rank: undefined } }));

    expect(text).toContain('#1');
  });
});
