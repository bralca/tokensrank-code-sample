import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ACCENT_LIME,
  AvatarWithBadge,
  DARK_BG,
  type AvatarWithBadgeProps,
} from '../avatar-with-badge';

const verifiedBadge = {
  slug: 'tier',
  name: 'Tier',
  color_hex: '#FFB020',
};

const colorAliasBadge = {
  slug: 'operator',
  name: 'Operator',
  color: '#00D084',
};

const baseProps = {
  handle: 'alex',
  mode: 'script_verified',
} satisfies AvatarWithBadgeProps;

function renderAvatar(props: Partial<AvatarWithBadgeProps> = {}) {
  const markup = renderToStaticMarkup(<AvatarWithBadge {...baseProps} {...props} />);
  const container = document.createElement('div');
  container.innerHTML = markup;

  return {
    root: container.querySelector('[data-testid="avatar-with-badge"]') as HTMLElement,
    image: container.querySelector('[data-testid="avatar-image"]') as HTMLImageElement | null,
    fallback: container.querySelector('[data-testid="avatar-fallback"]') as HTMLElement | null,
    pip: container.querySelector('[data-testid="avatar-verification-pip"]') as HTMLElement | null,
    ring: container.querySelector('[data-testid="avatar-badge-ring"]') as HTMLElement | null,
  };
}

describe('AvatarWithBadge', () => {
  describe('props and defaults', () => {
    it('renders with only required handle and mode props', () => {
      const { root, pip } = renderAvatar();

      expect(root).not.toBeNull();
      expect(pip).not.toBeNull();
    });

    it('defaults to the medium size variant', () => {
      const { root } = renderAvatar();

      expect(root.dataset.size).toBe('medium');
      expect(root.style.width).toBe('96px');
      expect(root.style.height).toBe('96px');
    });

    it('defaults showBadgeRing to true but needs a badge color to render a ring', () => {
      const { ring } = renderAvatar();

      expect(ring).toBeNull();
    });

    it('exports binding color constants', () => {
      expect(ACCENT_LIME).toBe('#B6FF3C');
      expect(DARK_BG).toBe('#0A0A0A');
    });

    it('merges a custom className into the outer container', () => {
      const { root } = renderAvatar({ className: 'custom-avatar-class' });

      expect(root.className).toContain('custom-avatar-class');
      expect(root.className).toContain('relative');
    });
  });

  describe('verified mode rendering', () => {
    it('renders a checkmark for script verified mode', () => {
      const { pip } = renderAvatar({ mode: 'script_verified' });

      expect(pip?.textContent).toBe('✓');
    });

    it('uses the required verified aria-label on the wrapper', () => {
      const { root, pip } = renderAvatar({ mode: 'script_verified' });

      expect(root.getAttribute('aria-label')).toBe('Verified via script');
      expect(root.getAttribute('role')).toBe('group');
      expect(pip?.getAttribute('aria-hidden')).toBe('true');
    });

    it('uses the acid-lime color for the verified pip', () => {
      const { pip } = renderAvatar({ mode: 'script_verified' });

      expect(pip?.getAttribute('style')).toContain(`background-color:${ACCENT_LIME}`);
      expect(pip?.getAttribute('style')).toContain(`color:${DARK_BG}`);
    });

    it('renders the pip at the bottom-right position', () => {
      const { pip } = renderAvatar({ mode: 'script_verified' });

      expect(pip?.className).toContain('absolute');
      expect(pip?.className).toContain('right-0');
      expect(pip?.className).toContain('bottom-0');
    });

    it('renders the pip at the compact leaderboard size', () => {
      const { pip } = renderAvatar({ mode: 'script_verified' });

      expect(pip?.style.width).toBe('17px');
      expect(pip?.style.height).toBe('17px');
      expect(pip?.style.fontSize).toBe('12px');
    });
  });

  describe('self-reported mode rendering', () => {
    it('renders the wave glyph for self-reported mode', () => {
      const { pip } = renderAvatar({ mode: 'self_reported' });

      expect(pip?.textContent).toBe('~');
    });

    it('uses the required self-reported aria-label on the wrapper', () => {
      const { root, pip } = renderAvatar({ mode: 'self_reported' });

      expect(root.getAttribute('aria-label')).toBe('Self-reported');
      expect(root.getAttribute('role')).toBe('group');
      expect(pip?.getAttribute('aria-hidden')).toBe('true');
    });

    it('uses a neutral color instead of acid lime for self-reported mode', () => {
      const { pip } = renderAvatar({ mode: 'self_reported' });

      expect(pip?.getAttribute('style')).toContain('background-color:#848E9C');
      expect(pip?.getAttribute('style')).not.toContain(`background-color:${ACCENT_LIME}`);
    });
  });

  describe('avatar image and fallback', () => {
    it('renders avatar image src when avatar_url is present', () => {
      const { image } = renderAvatar({ avatar_url: 'https://example.com/avatar.png' });

      expect(image?.getAttribute('src')).toBe('/avatar-proxy?url=https%3A%2F%2Fexample.com%2Favatar.png');
      expect(image?.getAttribute('data-original-src')).toBe('https://example.com/avatar.png');
    });

    it('renders avatar image alt text with the handle', () => {
      const { image } = renderAvatar({ avatar_url: 'https://example.com/avatar.png' });

      expect(image?.getAttribute('alt')).toBe('avatar for alex');
    });

    it('does not render the fallback initial when image is present', () => {
      const { fallback } = renderAvatar({ avatar_url: 'https://example.com/avatar.png' });

      expect(fallback).toBeNull();
    });

    it('renders an uppercase fallback initial when avatar_url is absent', () => {
      const { fallback } = renderAvatar({ handle: 'builder' });

      expect(fallback?.textContent).toBe('B');
    });

    it('renders accessible fallback avatar text', () => {
      const { fallback } = renderAvatar({ handle: 'builder' });

      expect(fallback?.getAttribute('role')).toBe('img');
      expect(fallback?.getAttribute('aria-label')).toBe('avatar for builder');
    });

    it('uses a question mark fallback for blank handles', () => {
      const { fallback } = renderAvatar({ handle: '   ' });

      expect(fallback?.textContent).toBe('?');
      expect(fallback?.getAttribute('aria-label')).toBe('avatar for    ');
    });

    it('applies the small size variant as 64px', () => {
      const { root } = renderAvatar({ size: 'small' });

      expect(root.style.width).toBe('64px');
      expect(root.style.height).toBe('64px');
    });

    it('applies the large size variant as 128px', () => {
      const { root } = renderAvatar({ size: 'large' });

      expect(root.style.width).toBe('128px');
      expect(root.style.height).toBe('128px');
    });
  });

  describe('badge ring', () => {
    it('renders a badge ring when badges include a color_hex', () => {
      const { ring } = renderAvatar({ badges: [verifiedBadge] });

      expect(ring).not.toBeNull();
    });

    it('uses the first badge color_hex for the ring', () => {
      const { ring } = renderAvatar({ badges: [verifiedBadge] });

      expect(ring?.getAttribute('style')).toContain('border-color:#FFB020');
    });

    it('supports leaderboard badge color alias for the ring', () => {
      const { ring } = renderAvatar({ badges: [colorAliasBadge] });

      expect(ring?.getAttribute('style')).toContain('border-color:#00D084');
    });

    it('uses a subtle 1px stroke for the badge ring', () => {
      const { ring } = renderAvatar({ badges: [verifiedBadge] });

      expect(ring?.className).toContain('border-[1px]');
    });

    it('does not render the badge ring when showBadgeRing is false', () => {
      const { ring } = renderAvatar({
        badges: [verifiedBadge],
        showBadgeRing: false,
      });

      expect(ring).toBeNull();
    });

    it('does not render a ring for invalid badge colors', () => {
      const { ring } = renderAvatar({
        badges: [{ slug: 'bad-color', color_hex: 'lime' }],
      });

      expect(ring).toBeNull();
    });
  });

  describe('accessibility', () => {
    it('does not rely on color alone because verified uses a checkmark shape', () => {
      const { pip } = renderAvatar({ mode: 'script_verified' });

      expect(pip?.textContent).toBe('✓');
      expect(pip?.getAttribute('aria-hidden')).toBe('true');
    });

    it('does not rely on color alone because self-reported uses a distinct glyph', () => {
      const { pip } = renderAvatar({ mode: 'self_reported' });

      expect(pip?.textContent).toBe('~');
      expect(pip?.getAttribute('aria-hidden')).toBe('true');
    });

    it('pairs image alt text with wrapper aria-label', () => {
      const { root, image, pip } = renderAvatar({
        avatar_url: 'https://example.com/avatar.png',
        mode: 'script_verified',
      });

      expect(image?.getAttribute('alt')).toBe('avatar for alex');
      expect(root.getAttribute('aria-label')).toBe('Verified via script');
      expect(pip?.getAttribute('aria-hidden')).toBe('true');
    });

    it('renders no verification pip or wrapper label for null mode', () => {
      const { root, pip } = renderAvatar({ mode: null });

      expect(root.hasAttribute('aria-label')).toBe(false);
      expect(root.hasAttribute('role')).toBe(false);
      expect(pip).toBeNull();
    });
  });
});
