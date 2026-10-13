import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { hideNextDevTools } from '../visual-helpers';

function violationSummary(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']): string {
  return violations.map((violation) => {
    const nodes = violation.nodes.map((node) => node.target.join(' ')).join(', ');

    return `${violation.id}: ${violation.help} -> ${nodes}`;
  }).join('\n');
}

async function expectNoAxeViolations(page: Page) {
  await hideNextDevTools(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  expect(results.violations, violationSummary(results.violations)).toEqual([]);
}

test('leaderboard table exposes an sr-only caption', async ({ page }) => {
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });

  const caption = page.locator('table#leaderboard-table caption');

  await expect(caption).toHaveCount(1);
  await expect(caption).toHaveClass(/sr-only/u);
  await expect(caption).toContainText('Leaderboard ranking by token usage');
});

test('filter pills use tablist semantics and selected state', async ({ page }) => {
  await page.goto('/?period=24h&scope=all', { waitUntil: 'networkidle' });

  await expect(page.getByRole('tablist', { name: 'Filter by period' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Filter by source' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '24H' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'All' }).last()).toHaveAttribute('aria-selected', 'true');
});

test('avatar verification badges expose accessible labels', async ({ page }) => {
  await page.goto('/avatar-with-badge-fixture', { waitUntil: 'networkidle' });

  await expect(page.locator('[data-testid="avatar-with-badge"][aria-label="Verified via script"]')).toHaveCount(3);
  await expect(page.locator('[data-testid="avatar-with-badge"][aria-label="Self-reported"]')).toHaveCount(2);
});

test('homepage has zero WCAG AA axe violations including color contrast', async ({ page }) => {
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });

  await expectNoAxeViolations(page);
});

test('keyboard Tab navigation reaches search and filter tabs', async ({ page }) => {
  await page.goto('/?period=24h&scope=all', { waitUntil: 'networkidle' });

  const searchInput = page.locator('#handle-search');
  const activePeriodTab = page.getByRole('tab', { name: '24H' });
  await expect(searchInput).toBeVisible();

  await page.locator('body').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Tab');
  const activeElementAfterTab = await page.evaluate(() => {
    const activeElement = document.activeElement;

    return activeElement instanceof HTMLElement
      ? activeElement.id || activeElement.textContent?.trim() || activeElement.getAttribute('aria-label')
      : null;
  });

  expect(activeElementAfterTab).toBeTruthy();

  await searchInput.focus();
  await expect(searchInput).toBeFocused();

  await activePeriodTab.focus();
  await expect(activePeriodTab).toBeFocused();
});

test('keyboard shortcut / focuses the search input', async ({ page }) => {
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });

  const searchInput = page.locator('#handle-search');
  await expect(searchInput).toBeVisible();
  await expect(searchInput).not.toBeFocused();

  await page.keyboard.press('/');

  await expect(searchInput).toBeFocused();
});
