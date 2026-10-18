import { expect, test as base } from '@playwright/test';

export { expect, type Page } from '@playwright/test';

export const test = base.extend<{ applicationErrors: string[] }>({
  applicationErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    const collect = (error: Error) => {
      // Monaco uses this exact cancellation error when async editor work stops.
      if (error.name === 'Canceled' && error.message === 'Canceled') return;
      errors.push(error.stack ?? error.message);
    };
    page.on('pageerror', collect);
    await use(errors);
    page.off('pageerror', collect);
    expect(errors, 'unexpected browser application errors').toEqual([]);
  }, { auto: true }],
});
