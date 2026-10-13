import { expect, type Page } from '@playwright/test';

export async function fillFormField(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await expect(field).toBeVisible();
  await field.fill(value);
}

export async function clickTest(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId);
  await expect(target).toBeVisible();
  await target.click();
}
