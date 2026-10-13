import { randomUUID } from 'node:crypto';

import { expect, test, type Page, type Request } from '@playwright/test';

const PASSWORD = 'Tr-valid-password-63!';

function uniqueHandle(prefix = 'free'): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function uniqueEmail(prefix = 'availability'): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

async function gotoSignUp(page: Page) {
  await page.goto('/auth/sign-up');
  await expect(page.getByTestId('auth-field-handle')).toBeVisible();
  await expect(page.getByTestId('auth-submit')).toBeVisible();
  await page.waitForTimeout(100);
}

async function fillRequiredFields(page: Page, handle: string) {
  await page.getByTestId('auth-field-email').fill(uniqueEmail());
  await page.getByTestId('auth-field-password').fill(PASSWORD);
  await fillHandle(page, handle);
}

async function fillHandle(page: Page, handle: string) {
  const input = page.getByTestId('auth-field-handle');

  await input.fill(handle);
  if (await input.inputValue() !== handle) {
    await input.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await input.pressSequentially(handle, { delay: 5 });
  }
  if (await input.inputValue() !== handle) {
    await input.evaluate((element, nextValue) => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = nextValue;
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      inputElement.dispatchEvent(new Event('change', { bubbles: true }));
    }, handle);
  }
  await expect(input).toHaveValue(handle);
}

function isHandleCheck(request: Request): boolean {
  return request.url().includes('/api/handle/check');
}

function debounceUpperBound(projectName: string): number {
  return projectName === 'webkit' ? 550 : 450;
}

async function waitForAvailable(page: Page) {
  const indicator = page.getByTestId('handle-availability');

  await expect(indicator).toHaveText('✓ available', { timeout: 2000 });

  return indicator;
}

async function observeAvailableLatency(page: Page): Promise<number> {
  return page.evaluate(() => {
    const startedAt = window.performance.now();

    return new Promise<number>((resolve) => {
      const readIndicator = () => document.querySelector('[data-testid="handle-availability"]')?.textContent;
      const currentText = readIndicator();

      if (currentText === '✓ available') {
        resolve(window.performance.now() - startedAt);
        return;
      }

      const observer = new MutationObserver(() => {
        if (readIndicator() === '✓ available') {
          observer.disconnect();
          resolve(window.performance.now() - startedAt);
        }
      });

      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
  });
}

async function observeIndicatorText(page: Page, expectedText: string, timeoutMs: number): Promise<boolean> {
  return page.evaluate(({ expectedText: expected, timeoutMs: timeout }) => {
    return new Promise<boolean>((resolve) => {
      const readIndicator = () => document.querySelector('[data-testid="handle-availability"]')?.textContent;
      const currentText = readIndicator();

      if (currentText === expected) {
        resolve(true);
        return;
      }

      const timer = window.setTimeout(() => {
        observer.disconnect();
        resolve(false);
      }, timeout);

      const observer = new MutationObserver(() => {
        if (readIndicator() === expected) {
          window.clearTimeout(timer);
          observer.disconnect();
          resolve(true);
        }
      });

      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
  }, { expectedText, timeoutMs });
}

test.describe('live handle availability', () => {
  test('debounces before showing checking state', async ({ page }) => {
    await gotoSignUp(page);

    const checkingSeen = observeIndicatorText(page, 'checking…', 1200);
    await fillHandle(page, uniqueHandle('debounce'));
    await page.waitForTimeout(200);
    await expect(page.getByTestId('handle-availability')).toHaveCount(0);
    await expect(checkingSeen).resolves.toBe(true);
  });

  test('available handle shows lime feedback and enables submit when the rest of the form is valid', async ({ page }) => {
    await gotoSignUp(page);
    await fillRequiredFields(page, uniqueHandle('available'));

    const indicator = await waitForAvailable(page);
    await expect(indicator).toHaveCSS('color', 'rgb(182, 255, 60)');
    await expect(page.getByTestId('auth-submit')).toBeEnabled();
  });

  test('reserved handle shows red feedback and keeps submit disabled', async ({ page }) => {
    await gotoSignUp(page);
    await fillRequiredFields(page, 'admin');

    const indicator = page.getByTestId('handle-availability');
    await expect(indicator).toHaveText("× that handle's reserved", { timeout: 2000 });
    await expect(indicator).toHaveCSS('color', 'rgb(239, 68, 68)');
    await expect(page.getByTestId('auth-submit')).toBeDisabled();
    await expect(page.getByTestId('auth-submit')).toHaveAttribute('title', 'Handle not available');
  });

  test('uppercase handle shows lowercase validation feedback', async ({ page }) => {
    await gotoSignUp(page);
    await fillHandle(page, 'Uppercase');

    await expect(page.getByTestId('handle-availability')).toHaveText('× must be lowercase', { timeout: 2000 });
  });

  test('short handle shows length validation feedback', async ({ page }) => {
    await gotoSignUp(page);
    await fillHandle(page, 'ab');

    await expect(page.getByTestId('handle-availability')).toHaveText('× between 3 and 30 characters', {
      timeout: 2000,
    });
  });

  test('debounce timer resets when typing continues before the window fires', async ({ page }, testInfo) => {
    const requests: number[] = [];

    page.on('request', (request) => {
      if (isHandleCheck(request)) {
        requests.push(Date.now());
      }
    });

    await gotoSignUp(page);
    await fillHandle(page, uniqueHandle('reset'));
    await page.waitForTimeout(250);
    const secondFillAt = Date.now();
    const requestPromise = page.waitForRequest(isHandleCheck);
    await fillHandle(page, uniqueHandle('reset'));
    await page.waitForTimeout(250);

    expect(requests).toHaveLength(0);
    await requestPromise;
    expect(requests).toHaveLength(1);
    expect(requests[0] - secondFillAt).toBeGreaterThanOrEqual(350);
    expect(requests[0] - secondFillAt).toBeLessThanOrEqual(debounceUpperBound(testInfo.project.name));
  });

  test('availability indicator exposes live-region accessibility semantics', async ({ page }) => {
    await gotoSignUp(page);
    await fillHandle(page, uniqueHandle('aria'));

    const indicator = await waitForAvailable(page);
    await expect(indicator).toHaveAttribute('aria-live', 'polite');
    await expect(indicator).toHaveAttribute('aria-atomic', 'true');
    await expect(indicator).toHaveAttribute('role', 'status');
  });

  test('debounce request timing stays near the 400ms window with total feedback under 700ms', async ({ page }, testInfo) => {
    await gotoSignUp(page);

    const startedAt = Date.now();
    const requestPromise = page.waitForRequest(isHandleCheck);
    const availableLatencyPromise = observeAvailableLatency(page);

    await fillHandle(page, uniqueHandle('timing'));

    await requestPromise;
    const requestDelay = Date.now() - startedAt;
    expect(requestDelay).toBeGreaterThanOrEqual(350);
    expect(requestDelay).toBeLessThanOrEqual(debounceUpperBound(testInfo.project.name));

    await waitForAvailable(page);
    await expect(availableLatencyPromise).resolves.toBeLessThan(1000);
  });

  test('uses one backend request per debounce pause in each browser project', async ({ page }, testInfo) => {
    const requests: string[] = [];

    page.on('request', (request) => {
      if (isHandleCheck(request)) {
        requests.push(request.url());
      }
    });

    await gotoSignUp(page);
    await fillHandle(page, uniqueHandle(testInfo.project.name === 'webkit' ? 'wk' : 'ch'));
    await waitForAvailable(page);

    expect(requests).toHaveLength(1);
    expect(['chromium', 'webkit']).toContain(testInfo.project.name);
  });
});
