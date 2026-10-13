import { expect, test } from '@playwright/test';

import { seedOGProfile } from './og-test-data';

test.describe.configure({ mode: 'serial' });

test.skip(({ browserName }) => browserName !== 'chromium', 'Server-generated PNG visual snapshots run once in Chromium.');

test.beforeAll(async () => {
  await seedOGProfile('alex');
});

test('OG variant A matches the visual baseline', async ({ request }) => {
  const response = await request.get('/og/u/alex.png?v=a');

  expect(response.status()).toBe(200);
  expect(await response.body()).toMatchSnapshot('og-variant-a.png', {
    maxDiffPixels: 1,
  });
});

test('OG variant B matches the visual baseline', async ({ request }) => {
  const response = await request.get('/og/u/alex.png?v=b');

  expect(response.status()).toBe(200);
  expect(await response.body()).toMatchSnapshot('og-variant-b.png', {
    maxDiffPixels: 1,
  });
});
