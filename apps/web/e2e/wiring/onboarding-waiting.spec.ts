import { createHash, randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
  type Response as PlaywrightResponse,
} from '@playwright/test';

const PASSWORD = 'Tr-valid-password-QC6!';
const API_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const WEB_ORIGIN = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;
type ScriptIngestResponse = {
  accepted?: number;
  data?: {
    accepted?: number;
  };
};

function uniqueHandle(prefix = 'qc6a'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function uniqueEmail(handle: string): string {
  const safeLocalPart = handle.replace(/_/g, '-');

  return `${safeLocalPart}-${randomUUID()}@tokensrank.dev`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildScriptPayload(handle: string) {
  const startedAt = '2026-04-28T10:00:00.000Z';
  const finishedAt = '2026-04-28T10:05:00.000Z';
  const safeHandle = handle.replace(/[^a-z0-9_-]/g, '-');

  return {
    client: {
      version: '1.0.0',
      install_id: randomUUID(),
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: `qc6-onboarding-${safeHandle}`,
      started_at: startedAt,
      finished_at: finishedAt,
    },
    sessions: [
      {
        session_id: `qc6-onboarding-${safeHandle}-session-0`,
        model: 'claude-3-5-sonnet-20241022',
        source: 'claude',
        first_event_at: startedAt,
        last_event_at: finishedAt,
        input_tokens: 12000,
        output_tokens: 3200,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
        turns: 3,
        file_sha256: sha256(`qc6-onboarding-${safeHandle}`),
      },
    ],
  };
}

async function enterText(locator: Locator, value: string): Promise<void> {
  await locator.fill('');
  await locator.pressSequentially(value);
  await expect(locator).toHaveValue(value);
}

async function bridgeAuthCookies(page: Page, response: APIResponse | PlaywrightResponse): Promise<void> {
  const setCookieHeaders = (await response.headersArray())
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);

  expect(setCookieHeaders.length).toBeGreaterThanOrEqual(2);

  await page.context().addCookies(setCookieHeaders.map((header) => {
    const [pair = ''] = header.split(';');
    const separator = pair.indexOf('=');

    return {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      url: WEB_ORIGIN,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    };
  }));
}

async function openOnboardingModeSelect(page: Page): Promise<boolean> {
  const modeSelect = page.getByTestId('onboarding-mode-select');
  const signInHeading = page.getByRole('heading', { name: 'Sign in to TokensRank' });
  const waitForModeOrSignIn = async () => await Promise.race([
    modeSelect.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false),
    signInHeading.waitFor({ state: 'visible', timeout: 20000 }).then(() => false).catch(() => false),
    page.waitForTimeout(20000).then(() => false),
  ]);

  await page.waitForURL(/\/(?:onboarding|auth\/sign-in)$/u, { timeout: 5000 }).catch(() => undefined);

  if (await waitForModeOrSignIn()) {
    return true;
  }

  if (!/\/onboarding$/u.test(new URL(page.url()).pathname)) {
    await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
  }

  return await waitForModeOrSignIn();
}

async function signIn(page: Page, email: string): Promise<void> {
  const signInResponse = await page.request.post(`${API_BASE_URL}/api/auth/sign-in`, {
    data: {
      email,
      password: PASSWORD,
    },
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: WEB_ORIGIN,
    },
  });
  const body = await signInResponse.json().catch(async () => await signInResponse.text());

  expect(signInResponse.status(), JSON.stringify(body)).toBe(200);
  await bridgeAuthCookies(page, signInResponse);
  expect(await openOnboardingModeSelect(page)).toBe(true);
}

async function signUp(page: Page, handle: string): Promise<void> {
  const email = uniqueEmail(handle);

  await page.goto('/auth/sign-up');
  await enterText(page.getByTestId('auth-field-email'), email);
  await enterText(page.getByTestId('auth-field-password'), PASSWORD);
  await enterText(page.getByTestId('auth-field-handle'), handle);
  await expect(page.getByTestId('handle-availability')).toHaveText('✓ available', { timeout: 5000 });
  await expect(page.getByTestId('auth-submit')).toBeEnabled();

  const signUpResponsePromise = page.waitForResponse((response) => (
    response.url().includes('/api/auth/sign-up')
  ));
  await page.getByTestId('auth-submit').click();
  const signUpResponse = await signUpResponsePromise;
  const signUpBody = signUpResponse.status() === 302
    ? { redirect: signUpResponse.headers().location }
    : await signUpResponse.json().catch(async () => await signUpResponse.text());

  expect(signUpResponse.status(), JSON.stringify(signUpBody)).toBe(302);
  expect(signUpResponse.headers().location).toBe('/onboarding');
  await bridgeAuthCookies(page, signUpResponse);

  const modeSelect = page.getByTestId('onboarding-mode-select');

  if (!await openOnboardingModeSelect(page)) {
    await signIn(page, email);
  }

  await expect(modeSelect).toBeVisible({ timeout: 15000 });
}

async function chooseScriptMode(page: Page): Promise<void> {
  await expect(page.getByTestId('onboarding-mode-select')).toBeVisible({ timeout: 15000 });
  const scriptMode = page.getByTestId('onboarding-mode-script');
  const nextButton = page.getByTestId('onboarding-next');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await scriptMode.click({ force: true });

    if (await nextButton.isEnabled().catch(() => false)) {
      break;
    }

    await page.waitForTimeout(250);
  }

  await expect(scriptMode).toHaveAttribute('aria-selected', 'true');
  await expect(nextButton).toBeEnabled();
  await page.getByTestId('onboarding-next').click();
  await expect(page).toHaveURL(/\/onboarding\/waiting\?mode=script/, { timeout: 20000 });
}

async function postScriptSession(page: Page, accessKey: string, handle: string): Promise<ScriptIngestResponse> {
  return await page.evaluate(async ({ apiBaseUrl, token, payload }) => {
    const response = await fetch(`${apiBaseUrl}/api/script/sessions`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));

    if (response.status !== 202) {
      throw new Error(`Script ingest failed with ${response.status}: ${JSON.stringify(body)}`);
    }

    return body as ScriptIngestResponse;
  }, {
    apiBaseUrl: API_BASE_URL,
    token: accessKey,
    payload: buildScriptPayload(handle),
  });
}

test.describe('QC-6 onboarding wiring', () => {
  test('sign-up Mode A detects a real script upload and redirects to verified profile', async ({ page }) => {
    test.setTimeout(90000);

    const handle = uniqueHandle();

    await signUp(page, handle);
    await chooseScriptMode(page);

    await expect(page.getByTestId('onboarding-script-install')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('status')).toContainText(/Listening for connection|Polling for connection/u, {
      timeout: 2000,
    });
    await expect(page.getByTestId('onboarding-live-log')).toContainText(
      /Handshake complete|Polling every 5 seconds|Still listening/u,
      { timeout: 10000 },
    );

    const accessKey = (await page.getByTestId('access-key-plaintext').textContent())?.trim();
    expect(accessKey).toMatch(/^tr_script_[A-Za-z0-9_-]{32}$/);

    const ingest = await postScriptSession(page, accessKey as string, handle);
    expect(ingest.accepted ?? ingest.data?.accepted).toBe(1);

    await page.getByTestId('access-key-confirm').check();
    await expect(page.getByTestId('access-key-done')).toBeEnabled();
    await page.getByTestId('access-key-done').click();

    await expect(page).toHaveURL(new RegExp(`/u/${handle}$`), { timeout: 30000 });
    await expect(page.getByTestId('profile-section-identity')).toContainText('Script verified');
    await expect(page.getByTestId('avatar-with-badge')).toHaveAttribute('aria-label', 'Verified via script');
    await expect(page.getByTestId('avatar-verification-pip')).toHaveAttribute('aria-hidden', 'true');
  });
});
