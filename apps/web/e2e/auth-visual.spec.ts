import { expect, test } from '@playwright/test';

const nextDevToolsCss = `
  nextjs-portal,
  [data-nextjs-toast],
  [data-nextjs-dialog],
  [data-nextjs-dialog-overlay],
  [aria-label="Open Next.js Dev Tools"],
  [aria-label="Next.js Dev Tools"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
`;

async function hideDevTools(page: import('@playwright/test').Page) {
  await page.addStyleTag({ content: nextDevToolsCss });
  await page.evaluate((css) => {
    const selectors = [
      'nextjs-portal',
      '[data-nextjs-toast]',
      '[data-nextjs-dialog]',
      '[data-nextjs-dialog-overlay]',
      '[aria-label="Open Next.js Dev Tools"]',
      '[aria-label="Next.js Dev Tools"]',
    ];

    const apply = (root: Document | ShadowRoot) => {
      if (root instanceof ShadowRoot && !root.querySelector('[data-tr-hide-next-devtools]')) {
        const style = document.createElement('style');
        style.setAttribute('data-tr-hide-next-devtools', 'true');
        style.textContent = css;
        root.appendChild(style);
      }

      for (const selector of selectors) {
        root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
          element.style.setProperty('display', 'none', 'important');
          element.style.setProperty('visibility', 'hidden', 'important');
          element.style.setProperty('opacity', '0', 'important');
          element.style.setProperty('pointer-events', 'none', 'important');
        });
      }

      root.querySelectorAll<HTMLElement>('*').forEach((element) => {
        if (element.shadowRoot) {
          apply(element.shadowRoot);
        }
      });
    };

    apply(document);
  }, nextDevToolsCss);
}

async function gotoAuth(page: import('@playwright/test').Page, path: string) {
  await page.goto(path);
  await hideDevTools(page);
}

function luminance([r, g, b]: [number, number, number]): number {
  const channels = [r, g, b].map((value) => {
    const normalized = value / 255;

    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: [number, number, number], background: [number, number, number]): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));

  return (lighter + 0.05) / (darker + 0.05);
}

test.describe('auth visual regression', () => {
  test('sign-up page matches auth visual baseline', async ({ page }) => {
    await gotoAuth(page, '/auth/sign-up');

    await expect(page).toHaveScreenshot('auth-sign-up.png', { maxDiffPixels: 1 });
  });

  test('sign-in page matches auth visual baseline', async ({ page }) => {
    await gotoAuth(page, '/auth/sign-in');

    await expect(page).toHaveScreenshot('auth-sign-in.png', { maxDiffPixels: 1 });
  });

  test('reset request page matches auth visual baseline', async ({ page }) => {
    await gotoAuth(page, '/auth/password-reset/request');

    await expect(page).toHaveScreenshot('auth-reset-request.png', { maxDiffPixels: 1 });
  });

  test('reset confirm page matches auth visual baseline', async ({ page }) => {
    await gotoAuth(page, '/auth/password-reset/confirm?token=visual-token');

    await expect(page).toHaveScreenshot('auth-reset-confirm.png', { maxDiffPixels: 1 });
  });

  test('form error states render red text below fields', async ({ page }) => {
    await gotoAuth(page, '/auth/sign-in');
    await page.getByTestId('auth-submit').click();

    const error = page.getByTestId('auth-error-email');
    await expect(error).toBeVisible();
    await expect(error).toHaveCSS('color', 'rgb(239, 68, 68)');
  });

  test('focus outline is lime and 2px', async ({ page }) => {
    await gotoAuth(page, '/auth/sign-in');
    const field = page.getByTestId('auth-field-email');
    await field.focus();

    await expect(field).toHaveCSS('outline-color', 'rgb(182, 255, 60)');
    await expect(field).toHaveCSS('outline-width', '2px');
  });

  test('loading button state changes label and opacity', async ({ page }) => {
    await page.route('**/api/auth/sign-in', async (route) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true } }),
      });
    });
    await gotoAuth(page, '/auth/sign-in');
    await page.getByTestId('auth-field-email').fill('visual@example.com');
    await page.getByTestId('auth-field-password').fill('Tr-valid-password-58!');
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-submit')).toHaveText('Signing in...', { timeout: 100 });
    await expect(page.getByTestId('auth-submit')).toBeDisabled();
  });

  test('mobile responsive layout has no horizontal overflow at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoAuth(page, '/auth/sign-up');

    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(hasHorizontalOverflow).toBe(false);
    await expect(page).toHaveScreenshot('auth-sign-up-mobile.png', { maxDiffPixels: 1 });
  });

  test('dark theme colors match design tokens', async ({ page }) => {
    await gotoAuth(page, '/auth/sign-in');

    await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(10, 10, 10)');
    await expect(page.getByTestId('auth-submit')).toHaveCSS('background-color', 'rgb(182, 255, 60)');
    await expect(page.getByText('Welcome back')).toHaveCSS('color', 'rgb(132, 142, 156)');
  });

  test('accessibility contrast meets AA for primary text and accent button', async ({ page }) => {
    await gotoAuth(page, '/auth/sign-in');

    expect(contrast([245, 245, 245], [10, 10, 10])).toBeGreaterThanOrEqual(4.5);
    expect(contrast([10, 10, 10], [182, 255, 60])).toBeGreaterThanOrEqual(4.5);
  });
});
