import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { hideNextDevTools } from './visual-helpers';

test.describe.configure({ mode: 'serial' });

const consoleErrorsByPage = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const consoleErrors: string[] = [];
  consoleErrorsByPage.set(page, consoleErrors);

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  page.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });
});

test.afterEach(({ page }) => {
  expect(consoleErrorsByPage.get(page) ?? []).toEqual([]);
});

function violationSummary(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']): string {
  return violations.map((violation) => {
    const nodes = violation.nodes.map((node) => node.target.join(' ')).join(', ');

    return `${violation.id}: ${violation.help} -> ${nodes}`;
  }).join('\n');
}

async function expectNoAxeViolations(page: Parameters<typeof hideNextDevTools>[0]) {
  await hideNextDevTools(page);
  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations, violationSummary(results.violations)).toEqual([]);
}

test('pressing / on homepage focuses handle-search input', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });

  const searchInput = page.locator('#handle-search');
  await expect(searchInput).toBeVisible();
  await expect(searchInput).not.toBeFocused();

  await page.keyboard.press('/');

  await expect(searchInput).toBeFocused();
});

test('typing / in an input field does not trigger the shortcut', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });

  const searchInput = page.locator('#handle-search');
  await expect(searchInput).toBeVisible();
  await searchInput.focus();
  await expect(searchInput).toBeFocused();

  await page.keyboard.press('/');

  await expect(searchInput).toBeFocused();
  await expect(searchInput).toHaveValue('/');

  await page.goto('/auth/sign-in', { waitUntil: 'networkidle' });
  await expect(page.locator('#handle-search')).toHaveCount(0);

  const emailInput = page.getByLabel('Email');
  await emailInput.focus();
  await expect(emailInput).toBeFocused();

  await page.keyboard.press('/');

  await expect(emailInput).toBeFocused();
  await expect(emailInput).toHaveValue('/');

  await page.locator('body').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('/');

  await expect(page.locator('#handle-search')).toHaveCount(0);
});

test('pressing / with Shift modifier does not trigger the shortcut', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });

  const searchInput = page.locator('#handle-search');
  const periodTab = page.getByRole('tab', { name: '24H' });
  await expect(searchInput).toBeVisible();
  await periodTab.focus();
  await expect(periodTab).toBeFocused();
  await expect(searchInput).not.toBeFocused();

  await page.keyboard.down('Shift');
  await page.keyboard.press('/');
  await page.keyboard.up('Shift');

  await expect(periodTab).toBeFocused();
  await expect(searchInput).not.toBeFocused();
});

test('search shortcut input preserves focus order and accessibility', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });

  await expectNoAxeViolations(page);

  const searchInput = page.locator('#handle-search');
  await expect(searchInput).toHaveAttribute('type', 'search');
  await expect(searchInput).toHaveAttribute('aria-label', 'Search builders by handle');
  await expect(searchInput).toHaveAttribute('placeholder', 'Search @handle - press / to focus');

  await page.locator('body').click({ position: { x: 8, y: 8 } });
  await expect(searchInput).not.toBeFocused();

  await page.keyboard.press('Tab');
  await expect(searchInput).toBeFocused();

  const focusStyle = await searchInput.evaluate((element) => {
    const style = window.getComputedStyle(element);

    return {
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });

  expect(focusStyle.outlineStyle).not.toBe('none');
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(2);
  expect(focusStyle.outlineColor).toBe('rgb(182, 255, 60)');

  const focusableOrder = await page.locator('input, a[href], button:not([disabled])').evaluateAll((elements) => elements
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })
    .map((element) => element.id || element.textContent?.trim() || element.getAttribute('aria-label')));

  expect(focusableOrder.slice(0, 2)).toEqual(['handle-search', '24H']);

  const periodTab = page.getByRole('tab', { name: '24H' });
  await periodTab.focus();
  await expect(periodTab).toBeFocused();
});
