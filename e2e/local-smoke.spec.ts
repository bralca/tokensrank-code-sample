import { expect, test } from '@playwright/test';

test('local dashboard renders real API totals and works on mobile without publishing', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await request.get('http://127.0.0.1:31771/local/profile?window=all');
  expect(response.ok()).toBe(true);
  const profile = await response.json();
  expect(profile.headline.tokens_total).toBe(12000);
  expect(profile.at_glance.sessions_count).toBe(1);

  await page.goto('/local/profile?window=all');
  await expect(page.getByRole('region', { name: 'Usage highlights' }).getByText('12K', { exact: true })).toBeVisible();
  await expect(page.getByTitle('gpt-5.5').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/local-desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'Usage highlights' }).getByText('12K', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/local-mobile.png', fullPage: true });
  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Models', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '7 days', exact: true }).click();
  await expect(page.getByRole('button', { name: '7 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
