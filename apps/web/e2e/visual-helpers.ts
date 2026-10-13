import type { Page } from '@playwright/test';

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

export async function hideNextDevTools(page: Page): Promise<void> {
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
