import { expect, test } from '@playwright/test';

test('renders the leaderboard shell', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /top builders by token usage/i })).toBeVisible();
});
