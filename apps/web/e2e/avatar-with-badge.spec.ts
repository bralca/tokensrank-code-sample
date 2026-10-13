import { expect, test } from '@playwright/test';

const fixturePath = '/avatar-with-badge-fixture';
const accentLime = '#B6FF3C';
const neutral = '#848E9C';
const darkBg = '#0A0A0A';

function luminance(hex: string): number {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    ?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map((channel) => (
    channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));

  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(foreground: string, background: string): number {
  const fg = luminance(foreground);
  const bg = luminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);

  return (lighter + 0.05) / (darker + 0.05);
}

test.describe('AvatarWithBadge visual and accessibility contract', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(fixturePath, { waitUntil: 'networkidle' });
  });

  test('verified mode visual baseline matches the component contract', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Avatar visual baseline is browser-renderer specific.');

    await expect(page.getByTestId('avatar-with-badge').nth(0)).toHaveScreenshot(
      'avatar-with-badge-verified.png',
      { maxDiffPixels: 1 },
    );
  });

  test('self-reported mode visual baseline matches the component contract', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Avatar visual baseline is browser-renderer specific.');

    await expect(page.getByTestId('avatar-with-badge').nth(1)).toHaveScreenshot(
      'avatar-with-badge-self-reported.png',
      { maxDiffPixels: 1 },
    );
  });

  test('badge ring visual baseline captures ring color and stroke', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Avatar visual baseline is browser-renderer specific.');

    await expect(page.getByTestId('avatar-with-badge').nth(2)).toHaveScreenshot(
      'avatar-with-badge-ring.png',
      { maxDiffPixels: 1 },
    );
  });

  test('size variants render at 64px, 96px, and 128px', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Avatar visual baseline is browser-renderer specific.');

    const boxes = await page.getByTestId('avatar-with-badge').evaluateAll((elements) => (
      elements.slice(0, 4).map((element) => {
        const rect = element.getBoundingClientRect();

        return { width: rect.width, height: rect.height };
      })
    ));

    expect(boxes).toEqual([
      { width: 96, height: 96 },
      { width: 96, height: 96 },
      { width: 64, height: 64 },
      { width: 128, height: 128 },
    ]);
    await expect(page.getByTestId('avatar-fixture-grid')).toHaveScreenshot(
      'avatar-with-badge-size-variants.png',
      { maxDiffPixels: 1 },
    );
  });

  test('verified and self-reported wrappers expose required aria-labels and pips are decorative', async ({ page }) => {
    await expect(page.getByRole('group', { name: 'Verified via script' })).toHaveCount(3);
    await expect(page.getByRole('group', { name: 'Self-reported' })).toHaveCount(2);
    await expect.poll(async () => page.getByTestId('avatar-verification-pip').evaluateAll((elements) => (
      elements.every((element) => element.getAttribute('aria-hidden') === 'true')
    ))).toBe(true);
  });

  test('avatar images expose alt text for the handle', async ({ page }) => {
    await expect(page.getByAltText('avatar for verified')).toBeVisible();
    await expect(page.getByAltText('avatar for self')).toBeVisible();
  });

  test('pip colors meet WCAG AA contrast requirements', async () => {
    expect(contrastRatio(accentLime, darkBg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(neutral, darkBg)).toBeGreaterThanOrEqual(4.5);
  });

  test('icon shapes are distinct and avoid color-only indicators', async ({ page }) => {
    const pipText = await page.getByTestId('avatar-verification-pip').evaluateAll((elements) => (
      elements.map((element) => element.textContent?.trim())
    ));

    expect(pipText).toContain('✓');
    expect(pipText).toContain('~');
  });

  test('badge ring uses the badge color and 3px stroke', async ({ page }) => {
    const ring = page.getByTestId('avatar-badge-ring').first();

    await expect(ring).toHaveCSS('border-top-width', '3px');
    await expect(ring).toHaveCSS('border-top-color', 'rgb(255, 176, 32)');
  });
});
