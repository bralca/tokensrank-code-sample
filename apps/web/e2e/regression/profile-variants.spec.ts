import { expect, test, type Page } from '@playwright/test';

import {
  clearNextFetchCache,
  createOutcomeProfile,
  purgeApiCache,
  setOwnerCookie,
  type SeededOutcomeProfile,
} from './profile-outcome-fixtures';

test.describe.configure({ mode: 'serial' });

async function expectProfileVariant(page: Page, variant: string, shareProjects: boolean): Promise<void> {
  await expect(page.locator('main')).toHaveAttribute('data-profile-variant', variant);
  await expect(page.locator('main')).toHaveAttribute('data-profile-share-projects', shareProjects ? 'true' : 'false');
}

async function expectProjectLabelsVisible(page: Page): Promise<void> {
  const tools = page.locator('[data-section="tools-breakdown"]');

  await expect(tools).toContainText('checkout');
  await expect(tools).toContainText('pricing');
}

async function expectProjectLabelsHidden(page: Page): Promise<void> {
  const tools = page.locator('[data-section="tools-breakdown"]');

  await expect(tools).not.toContainText('checkout');
  await expect(tools).not.toContainText('pricing');
}

async function openOwnerProfile(page: Page, profile: SeededOutcomeProfile): Promise<void> {
  await page.goto(`/u/${profile.handle}?window=all`, { waitUntil: 'networkidle' });
}

test('owner toggles share_projects on and sees immediate profile feedback', async ({ page, context }) => {
  const profile = await createOutcomeProfile('toggle', false);
  await setOwnerCookie(context, profile);

  await openOwnerProfile(page, profile);
  await expectProfileVariant(page, 'owner_share_false', false);
  await expectProjectLabelsHidden(page);

  await page.goto('/me/settings', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('profile-share-projects')).not.toBeChecked();
  await page.getByTestId('profile-share-projects').check();
  await expect(page.getByTestId('profile-share-projects')).toBeChecked();
  await page.getByTestId('profile-submit').click();

  await expect(page).toHaveURL(new RegExp(`/u/${profile.handle}`));
  await expect(page.getByTestId('profile-share-button')).toBeVisible();
  await expectProfileVariant(page, 'owner_share_true', true);
  await expectProjectLabelsVisible(page);

  await purgeApiCache();
  await clearNextFetchCache();
});

test('all four profile variants render the correct project visibility', async ({ page, context, browser }) => {
  const shareOff = await createOutcomeProfile('shareoff', false);
  const shareOn = await createOutcomeProfile('shareon', true);

  await setOwnerCookie(context, shareOff);
  await openOwnerProfile(page, shareOff);
  await expectProfileVariant(page, 'owner_share_false', false);
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expectProjectLabelsHidden(page);

  const shareOnOwnerContext = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}` });
  try {
    await setOwnerCookie(shareOnOwnerContext, shareOn);
    const ownerShareOnPage = await shareOnOwnerContext.newPage();
    await openOwnerProfile(ownerShareOnPage, shareOn);
    await expectProfileVariant(ownerShareOnPage, 'owner_share_true', true);
    await expect(ownerShareOnPage.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expectProjectLabelsVisible(ownerShareOnPage);
  } finally {
    await shareOnOwnerContext.close();
  }

  const publicContext = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}` });
  try {
    const publicShareOffPage = await publicContext.newPage();
    await publicShareOffPage.goto(`/u/${shareOff.handle}?window=all`, { waitUntil: 'networkidle' });
    await expectProfileVariant(publicShareOffPage, 'public_share_false', false);
    await expect(publicShareOffPage.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expectProjectLabelsHidden(publicShareOffPage);

    const publicShareOnPage = await publicContext.newPage();
    await publicShareOnPage.goto(`/u/${shareOn.handle}?window=all`, { waitUntil: 'networkidle' });
    await expectProfileVariant(publicShareOnPage, 'public_share_true', true);
    await expect(publicShareOnPage.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expectProjectLabelsVisible(publicShareOnPage);
  } finally {
    await publicContext.close();
  }

  await purgeApiCache();
  await clearNextFetchCache();
});

test('profile outcome page matches the visual baseline', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Profile visual baseline is captured once in Chromium.');

  const profile = await createOutcomeProfile('visual', true, { xHandle: null });
  await setOwnerCookie(context, profile);
  await page.setViewportSize({ width: 1280, height: 1200 });
  await openOwnerProfile(page, profile);
  await expectProfileVariant(page, 'owner_share_true', true);
  await expectProjectLabelsVisible(page);

  await expect(page).toHaveScreenshot('profile-share-projects-owner.png', {
    fullPage: true,
    maxDiffPixels: 1,
    mask: [
      page.locator('[data-section="identity"] p').first(),
      page.locator('[data-section="identity"] a[href^="https://x.com/"]'),
      page.locator('[data-section="headline-pair"] p').first(),
      page.locator('[data-section="sessions-list"] tbody td:first-child'),
      page.locator('[data-section="sessions-list"] article p:first-child'),
      page.locator('[data-section="recent-activity"] article p:first-child'),
    ],
  });
});

test('profile route renders a not-found state for invalid or missing handles', async ({ page, request }) => {
  const invalidProfile = await request.get('/u/x');
  const missingProfile = await request.get('/u/profilemissing95');

  expect(invalidProfile.status()).toBeGreaterThanOrEqual(400);
  expect(missingProfile.status()).toBe(200);

  await page.goto('/u/profilemissing95', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Profile not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View all builders' })).toHaveAttribute('href', '/');
});
