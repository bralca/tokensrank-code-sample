import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  Delta,
  LiveDot,
  Sparkline,
  StatCard,
  TierBadge,
  TRWordmark,
  type TierBadgeBadge,
} from '@/components';
import DeltaDefault from '../Delta';
import LiveDotDefault from '../LiveDot';
import SparklineDefault from '../Sparkline';
import StatCardDefault from '../StatCard';
import TierBadgeDefault from '../TierBadge';
import TRWordmarkDefault from '../TRWordmark';

function renderMarkup(element: React.ReactElement): {
  container: HTMLDivElement;
  markup: string;
} {
  const markup = renderToStaticMarkup(element);
  const container = document.createElement('div');
  container.innerHTML = markup;

  return { container, markup };
}

const badge = {
  slug: 'tier',
  name: 'Tier',
  icon_url: 'https://cdn.tokensrank.ai/badge-tier.png',
  color_hex: '#B6FF3C',
} satisfies TierBadgeBadge;

describe('design system barrel exports', () => {
  it('exports all six primitives as functions', () => {
    expect(TRWordmark).toBe(TRWordmarkDefault);
    expect(LiveDot).toBe(LiveDotDefault);
    expect(Delta).toBe(DeltaDefault);
    expect(TierBadge).toBe(TierBadgeDefault);
    expect(Sparkline).toBe(SparklineDefault);
    expect(StatCard).toBe(StatCardDefault);
  });
});

describe('TRWordmark', () => {
  it('renders acid-lime brackets, dim dot, and responsive sizes', () => {
    const { container } = renderMarkup(<TRWordmark size="lg" />);
    const root = container.querySelector('[data-testid="tr-wordmark"]') as HTMLElement;

    expect(root.getAttribute('role')).toBe('img');
    expect(root.getAttribute('aria-label')).toBe('TokensRank');
    expect(root.style.fontSize).toBe('32px');
    expect(root.style.fontWeight).toBe('600');
    expect(root.textContent).toBe('[tokens·rank]');
    expect(root.innerHTML).toContain('color:#B6FF3C');
    expect(root.innerHTML).toContain('color:#5C5C5C');
  });

  it('maps small and medium sizes to the specified pixels', () => {
    const small = renderMarkup(<TRWordmark size="sm" />).container.querySelector('[data-testid="tr-wordmark"]') as HTMLElement;
    const medium = renderMarkup(<TRWordmark />).container.querySelector('[data-testid="tr-wordmark"]') as HTMLElement;

    expect(small.style.fontSize).toBe('16px');
    expect(medium.style.fontSize).toBe('24px');
  });
});

describe('LiveDot', () => {
  it('renders a 4px pulsing acid-lime dot with status semantics', () => {
    const { container } = renderMarkup(<LiveDot label="waiting" />);
    const root = container.querySelector('[data-testid="live-dot"]') as HTMLElement;
    const dot = root.querySelector('[data-variant="pulse"]') as HTMLElement;

    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-label')).toBe('waiting');
    expect(root.textContent).toBe('waiting');
    expect(dot.className).toContain('h-1');
    expect(dot.className).toContain('w-1');
    expect(dot.className).toContain('tr-live-dot-pulse');
    expect(dot.getAttribute('style')).toContain('background-color:#B6FF3C');
  });

  it('renders the static variant without animation class', () => {
    const { container } = renderMarkup(<LiveDot variant="static" ariaLabel="connected" />);
    const dot = container.querySelector('[data-variant="static"]') as HTMLElement;

    expect(dot.className).not.toContain('tr-live-dot-pulse');
  });

  it('uses default status labels when no visible label is provided', () => {
    const pulse = renderMarkup(<LiveDot />).container.querySelector('[data-testid="live-dot"]') as HTMLElement;
    const stat = renderMarkup(<LiveDot variant="static" />).container.querySelector('[data-testid="live-dot"]') as HTMLElement;

    expect(pulse.getAttribute('aria-label')).toBe('Waiting for live activity');
    expect(stat.getAttribute('aria-label')).toBe('Live status');
  });
});

describe('Delta', () => {
  it('renders positive movement in acid lime with up aria label', () => {
    const { container } = renderMarkup(<Delta value={5} />);
    const delta = container.querySelector('[data-testid="delta"]') as HTMLElement;

    expect(delta.textContent).toBe('↑5');
    expect(delta.getAttribute('aria-label')).toBe('+5 up');
    expect(delta.getAttribute('style')).toContain('color:#B6FF3C');
  });

  it('renders negative movement in red with down aria label', () => {
    const { container } = renderMarkup(<Delta value={-3} />);
    const delta = container.querySelector('[data-testid="delta"]') as HTMLElement;

    expect(delta.textContent).toBe('↓3');
    expect(delta.getAttribute('aria-label')).toBe('-3 down');
    expect(delta.getAttribute('style')).toContain('color:#EF4444');
  });

  it('returns null for zero movement', () => {
    const { markup } = renderMarkup(<Delta value={0} />);

    expect(markup).toBe('');
  });
});

describe('TierBadge', () => {
  it('renders catalog badge icon, border, background, hover variable, and label', () => {
    const { container } = renderMarkup(<TierBadge badge={badge} showLabel />);
    const root = container.querySelector('[data-testid="tier-badge"]') as HTMLElement;
    const image = root.querySelector('img') as HTMLImageElement;

    expect(root.getAttribute('aria-label')).toBe('Tier');
    expect(root.textContent).toContain('Tier');
    expect(root.getAttribute('style')).toContain('border-color:#B6FF3C');
    expect(root.getAttribute('style')).toContain('rgba(182, 255, 60, 0.1)');
    expect(root.getAttribute('style')).toContain('--tier-badge-hover-bg:rgba(182, 255, 60, 0.2)');
    expect(image).not.toBeNull();
  });

  it('renders a color-dot fallback when icon_url is missing', () => {
    const { container } = renderMarkup(
      <TierBadge badge={{ ...badge, icon_url: null, color_hex: '#FFB020' }} />,
    );
    const root = container.querySelector('[data-testid="tier-badge"]') as HTMLElement;
    const fallback = root.querySelector('[aria-hidden="true"]') as HTMLElement;

    expect(root.querySelector('img')).toBeNull();
    expect(fallback.getAttribute('style')).toContain('background-color:#FFB020');
  });

  it('falls back to acid lime for invalid badge colors and accepts an aria override', () => {
    const { container } = renderMarkup(
      <TierBadge badge={{ ...badge, icon_url: null, color_hex: 'not-a-color' }} ariaLabel="Custom tier" size="lg" />,
    );
    const root = container.querySelector('[data-testid="tier-badge"]') as HTMLElement;

    expect(root.getAttribute('aria-label')).toBe('Custom tier');
    expect(root.dataset.color).toBe('#B6FF3C');
    expect(root.getAttribute('style')).toContain('height:36px');
  });
});

describe('Sparkline', () => {
  it('renders a smooth cubic path at the default 120 by 40 dimensions', () => {
    const { container } = renderMarkup(<Sparkline data={[10, 20, 12, 30, 22]} />);
    const svg = container.querySelector('[data-testid="sparkline"]') as SVGElement;
    const path = svg.querySelector('path') as SVGPathElement;

    expect(svg.getAttribute('width')).toBe('120');
    expect(svg.getAttribute('height')).toBe('40');
    expect(svg.getAttribute('aria-label')).toBe('Token usage trend');
    expect(path.getAttribute('d')).toContain(' C ');
    expect(path.getAttribute('stroke')).toBe('#B6FF3C');
  });

  it('renders the no-data state for fewer than two points', () => {
    const { container } = renderMarkup(<Sparkline data={[1]} />);
    const svg = container.querySelector('[data-testid="sparkline-empty"]') as SVGElement;

    expect(svg.getAttribute('aria-label')).toBe('No data');
    expect(svg.textContent).toContain('No data');
  });

  it('clamps invalid dimensions and renders flat equal-value data', () => {
    const { container } = renderMarkup(
      <Sparkline ariaLabel="Flat usage" data={[5, 5, 5]} height={Number.NaN} width={-1} />,
    );
    const svg = container.querySelector('[data-testid="sparkline"]') as SVGElement;
    const path = svg.querySelector('path') as SVGPathElement;

    expect(svg.getAttribute('width')).toBe('120');
    expect(svg.getAttribute('height')).toBe('40');
    expect(svg.getAttribute('aria-label')).toBe('Flat usage');
    expect(path.getAttribute('d')).toContain('20.00');
  });
});

describe('StatCard', () => {
  it('renders required label, value, unit, trend, and default border', () => {
    const { container } = renderMarkup(
      <StatCard label="token usage" value="42.1M" unit="tokens" trend={<span>+12%</span>} />,
    );
    const card = container.querySelector('[data-testid="stat-card"]') as HTMLElement;

    expect(card.getAttribute('aria-label')).toBe('token usage: 42.1M tokens');
    expect(card.getAttribute('style')).toContain('border:1px solid #2A2F38');
    expect(card.textContent).toContain('token usage');
    expect(card.textContent).toContain('42.1M');
    expect(card.textContent).toContain('tokens');
    expect(card.textContent).toContain('+12%');
    expect(card.innerHTML).toContain('font-size:12px');
    expect(card.innerHTML).toContain('font-size:24px');
    expect(card.innerHTML).toContain('font-weight:600');
  });

  it('applies accent variant theming and optional icon', () => {
    const { container } = renderMarkup(
      <StatCard icon={<span data-testid="icon">i</span>} label="rank" value="#7" variant="accent" />,
    );
    const card = container.querySelector('[data-testid="stat-card"]') as HTMLElement;

    expect(card.dataset.variant).toBe('accent');
    expect(card.getAttribute('style')).toContain('border:1px solid #B6FF3C');
    expect(card.querySelector('[data-testid="icon"]')).not.toBeNull();
  });
});
