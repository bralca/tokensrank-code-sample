import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;

function uniqueHandle(): string {
  return `integration_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function uniqueEmail(handle: string): string {
  return `${handle}-${randomUUID()}@example.com`;
}

async function addE2eOnboardingCookie(page: Page, handle: string) {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000077',
      email: uniqueEmail(handle),
      handle,
      displayName: null,
      avatarUrl: null,
      bio: null,
      xHandle: null,
      mode: null,
      onboardedAt: null,
      shareProjects: false,
      onboarding: {
        step: 'not_started',
      },
      accessKeys: [],
      recentIngestionRuns: [],
    })),
    url: webOrigin,
    sameSite: 'Lax',
  }]);
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });

  return errors;
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations.map((violation) => {
    const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ');

    return `${violation.id}: ${violation.help} -> ${targets}`;
  }).join('\n');

  expect(results.violations, summary).toEqual([]);
}

test('leaderboard filter click navigates and flips aria-selected without axe violations', async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);

  await page.goto('/?period=24h&scope=all');
  await expect(page.locator('#leaderboard-table')).toBeVisible();
  await expect(page.getByRole('tab', { name: '24H' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: '7D' })).toHaveAttribute('aria-selected', 'false');

  await page.getByRole('tab', { name: '7D' }).click();
  await expect(page).toHaveURL(/period=7d/);
  await expect(page.getByRole('tab', { name: '24H' })).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('tab', { name: '7D' })).toHaveAttribute('aria-selected', 'true');
  await expectNoAxeViolations(page);
  expect(consoleErrors).toEqual([]);
});

test('onboarding tab click swaps panel content without navigation and passes axe', async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const handle = uniqueHandle();

  await addE2eOnboardingCookie(page, handle);
  await page.goto('/onboarding');
  const initialUrl = page.url();

  await page.getByRole('tab', { name: /SELF-REPORTED/ }).click();
  await expect(page).toHaveURL(initialUrl);
  await expect(page.getByRole('tab', { name: /SELF-REPORTED/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('onboarding-mode-details')).toContainText('Post the same session shape from your own tooling');

  await page.getByRole('tab', { name: /VERIFIED/ }).click();
  await expect(page).toHaveURL(initialUrl);
  await expect(page.getByRole('tab', { name: /VERIFIED/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('onboarding-mode-details')).toContainText('Run the TokensRank agent locally');
  await expectNoAxeViolations(page);
  expect(consoleErrors).toEqual([]);
});
