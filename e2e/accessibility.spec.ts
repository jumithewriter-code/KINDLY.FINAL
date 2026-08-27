import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Automated accessibility sweep over every reachable screen, in a real browser
 * where colour contrast, focus order and layout can actually be measured.
 * The findings are summarised in docs/accessibility-report.md.
 */

const PASSWORD = 'kindly-demo-1';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** A failure should say which element failed and why, not just the rule id. */
function describeViolations(results: { violations: any[] }): string {
  return results.violations
    .flatMap((v) => v.nodes.map((n: any) =>
      `${v.id} ${JSON.stringify(n.target)} :: ${(n.any?.[0]?.message ?? v.help).replace(/\s+/g, ' ').slice(0, 160)}`))
    .join('\n');
}

async function signUpAndOnboard(page: Page) {
  await page.goto('/auth/create-account');
  await page.getByLabel('Email address', { exact: true }).fill(`a11y+${Date.now()}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create my space' }).click();

  await page.getByLabel('Your preferred name').fill('Rosa');
  await page.getByLabel('Your child’s name').fill('Léo');
  await page.getByLabel(/Another trusted caregiver/).fill('Grandma Ade');
  await page.getByLabel('Grown-up code', { exact: true }).fill('7391');
  await page.getByRole('button', { name: 'Continue' }).click();
  for (let i = 0; i < 4; i += 1) await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByRole('button', { name: 'Go to my space' }).click();
  await expect(page.getByRole('heading', { name: /Good morning/ })).toBeVisible();
}

const CAREGIVER_ROUTES = [
  '/app', '/app/stories', '/app/stories/new', '/app/requests', '/app/routines',
  '/app/routines/new', '/app/profile', '/app/settings', '/app/settings/children',
  '/app/settings/caregivers', '/app/settings/preferences', '/app/settings/safety',
  '/app/settings/notifications', '/app/settings/data',
];

const CHILD_ROUTES = ['/child', '/child/help', '/child/feelings', '/child/stories', '/child/day', '/child/offline-help'];

test.describe('accessibility', () => {
  test('every signed-out screen passes axe at WCAG 2.1/2.2 AA', async ({ page }) => {
    for (const route of ['/auth/sign-in', '/auth/create-account', '/auth/forgot-password', '/not-a-page']) {
      await page.goto(route);
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(results.violations, `${route}
${describeViolations(results)}`).toEqual([]);
    }
  });

  test('every caregiver screen passes axe at WCAG 2.1/2.2 AA', async ({ page }) => {
    await signUpAndOnboard(page);
    for (const route of CAREGIVER_ROUTES) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(results.violations, `${route}
${describeViolations(results)}`).toEqual([]);
    }
  });

  test('every child screen passes axe at WCAG 2.1/2.2 AA', async ({ page }) => {
    await signUpAndOnboard(page);
    await page.getByRole('button', { name: /Open Léo’s view/ }).click();
    await expect(page.getByRole('heading', { name: 'Hi Léo!' })).toBeVisible();

    for (const route of CHILD_ROUTES) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(results.violations, `${route}
${describeViolations(results)}`).toEqual([]);
    }
  });

  test('every interactive target is at least 44 by 44 CSS pixels', async ({ page }) => {
    await signUpAndOnboard(page);
    for (const route of ['/app', '/app/requests', '/app/settings']) {
      await page.goto(route);
      const tooSmall = await page.evaluate(() => {
        const problems: string[] = [];
        document.querySelectorAll('button, a[href], input, select, [role="button"]').forEach((el) => {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          // Inline links inside running text are exempt (WCAG 2.5.8).
          if (el.tagName === 'A' && el.closest('p, small')) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;
          if (rect.width < 44 || rect.height < 44) {
            problems.push(`${el.tagName}.${el.className} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
          }
        });
        return problems;
      });
      expect(tooSmall, route).toEqual([]);
    }
  });

  test('keyboard focus is always visible and reaches every control', async ({ page }) => {
    await signUpAndOnboard(page);
    await page.goto('/app/requests');

    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          key: `${el.tagName}:${el.textContent?.trim().slice(0, 30)}`,
          outline: style.outlineStyle,
        };
      });
      if (!info) break;
      seen.add(info.key);
      // Focus must be drawn, not left to the browser default we replaced.
      expect(info.outline, info.key).not.toBe('none');
    }
    expect(seen.size).toBeGreaterThan(8);
  });

  test('the page still works, and does not scroll sideways, at 200% zoom', async ({ page }) => {
    await signUpAndOnboard(page);
    await page.setViewportSize({ width: 640, height: 512 }); // 1280x1024 at 200%
    for (const route of ['/app', '/app/requests', '/app/settings/safety']) {
      await page.goto(route);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, route).toBeLessThanOrEqual(1);
    }
  });

  test('status is never carried by colour alone', async ({ page }) => {
    await signUpAndOnboard(page);
    await page.getByRole('button', { name: /Open Léo’s view/ }).click();
    await page.getByRole('button', { name: /I need help/ }).click();

    // Every request card states its urgency in words as well as colour.
    const tags = await page.locator('.req-tag').allTextContents();
    expect(tags.length).toBeGreaterThan(4);
    for (const tag of tags) {
      expect(tag.trim()).toMatch(/Urgent|Can wait/);
    }
  });
});
