import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type TestInfo } from '@playwright/test';

const webRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webRoot, '../..');
const geistStylesheet = 'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600;700&display=swap';

async function writeTimingReport(testInfo: TestInfo, report: unknown) {
  const reportDir = path.join(repoRoot, 'test-results');
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, `qc-7-font-timing-${testInfo.project.name}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

test('layout loads Geist fonts through link tags and does not import next/font', async () => {
  const layoutSource = await readFile(path.join(webRoot, 'app/layout.tsx'), 'utf8');

  expect(layoutSource).not.toContain('next/font');
  expect(layoutSource).toContain(`rel="preload"`);
  expect(layoutSource).toContain(`rel="stylesheet"`);
  expect(layoutSource).toContain(geistStylesheet);
});

test('browser activates Geist Sans and Geist Mono from linked stylesheet', async ({ page }, testInfo) => {
  const startedAt = Date.now();
  await page.goto('/', { waitUntil: 'networkidle' });

  const result = await page.evaluate(async () => {
    const stylesheetLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
      .map((link) => link.href)
      .filter((href) => href.includes('fonts.googleapis.com/css2?family=Geist'));

    await Promise.race([
      document.fonts.load('400 16px Geist'),
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error('Timed out waiting for Geist Sans')), 5000);
      }),
    ]);

    await Promise.race([
      document.fonts.load('400 16px "Geist Mono"'),
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error('Timed out waiting for Geist Mono')), 5000);
      }),
    ]);

    await document.fonts.ready;

    const bodyFamily = window.getComputedStyle(document.body).fontFamily;
    const monoElement = document.querySelector<HTMLElement>('.font-mono');
    const monoFamily = monoElement ? window.getComputedStyle(monoElement).fontFamily : '';
    const resources = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('fonts.googleapis.com') || entry.name.includes('fonts.gstatic.com'))
      .map((entry) => ({
        durationMs: Math.round(entry.duration),
        name: entry.name,
        startTimeMs: Math.round(entry.startTime),
      }));

    return {
      bodyFamily,
      geistMonoStatus: document.fonts.check('400 16px "Geist Mono"'),
      geistSansStatus: document.fonts.check('400 16px Geist'),
      monoFamily,
      resources,
      stylesheetLinks,
    };
  });

  const elapsedMs = Date.now() - startedAt;
  await writeTimingReport(testInfo, {
    ...result,
    elapsedMs,
  });

  expect(result.stylesheetLinks).toEqual([geistStylesheet]);
  expect(result.geistSansStatus).toBe(true);
  expect(result.geistMonoStatus).toBe(true);
  expect(result.bodyFamily).toContain('Geist');
  expect(result.monoFamily).toContain('Geist Mono');
  expect(elapsedMs).toBeLessThan(10_000);
});
