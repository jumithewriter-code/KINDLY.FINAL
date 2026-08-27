import { expect, test } from '@playwright/test';

/** Mobile layout checks. Runs under the Pixel 7 project in playwright.config.ts. */
test.describe('mobile layout', () => {
  test('nothing is clipped and nothing scrolls sideways', async ({ page }) => {
    await page.goto('/auth/create-account');
    await page.getByLabel('Email address', { exact: true }).fill(`mobile+${Date.now()}@example.test`);
    await page.getByLabel('Password', { exact: true }).fill('kindly-demo-1');
    await page.getByRole('button', { name: 'Create my space' }).click();

    await page.getByLabel('Your preferred name').fill('Rosa');
    await page.getByLabel('Your child’s name').fill('Léo');
    await page.getByLabel('Grown-up code', { exact: true }).fill('7391');
    await page.getByRole('button', { name: 'Continue' }).click();
    for (let i = 0; i < 4; i += 1) await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await page.getByRole('button', { name: 'Go to my space' }).click();

    for (const route of ['/app', '/app/requests', '/app/settings', '/app/profile']) {
      await page.goto(route);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, route).toBeLessThanOrEqual(1);
    }

    // Child mode on a small screen keeps its large, well-separated targets.
    await page.goto('/app');
    await page.getByRole('button', { name: /Open Léo’s view/ }).click();
    await expect(page.getByRole('heading', { name: 'Hi Léo!' })).toBeVisible();

    const cardSizes = await page.locator('.child-card').evaluateAll((els) =>
      els.map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
    expect(cardSizes.length).toBe(4);
    for (const size of cardSizes) {
      expect(size.w).toBeGreaterThanOrEqual(44);
      expect(size.h).toBeGreaterThanOrEqual(88);
    }
  });
});
