import { describe, expect, it } from 'vitest';

import { OGCardVariantB } from './og-card-variant-b';
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

describe('OGCardVariantB', () => {
  it('renders required profile fields and oversized accent rank', () => {
    const element = OGCardVariantB({ profile });
    const text = flattenText(element);
    const elements = collectElements(element);
    const avatar = elements.find((item) => item.type === 'img');
    const rankElement = elements.find((item) => {
      const style = item.props.style as { color?: string; fontSize?: string } | undefined;
      return style?.color === '#b63b13' && style.fontSize === '600px';
    });

    expect(text).toContain('@alex');
    expect(text).toContain('7');
    expect(text).toContain('1.5M tokens');
    expect(text).toContain('$12.34');
    expect(text).toContain('tokensrank.');
    expect(avatar?.props.src).toBe(profile.avatar_url);
    expect(rankElement).toBeDefined();
  });

  it('defaults missing rank to first place for share previews', () => {
    const text = flattenText(OGCardVariantB({ profile: { ...profile, rank: undefined } }));

    expect(text).toContain('1');
  });
});
