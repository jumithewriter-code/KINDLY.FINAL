import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** Proves the demo needs nothing but itself: opened straight off disk. */
test('the single-file demo runs standalone', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => errors.push(`failed request: ${r.url()}`));

  await page.goto(pathToFileURL(join(process.cwd(), 'demo', 'site', 'index.html')).href);

  await expect(page.getByRole('heading', { name: /Make more good days|Welcome back/ })).toBeVisible();
  await expect(page.getByText(/Demonstration build/)).toBeVisible();
  await expect(page.getByText(/not.*delivered to a real person/i)).toBeVisible();

  // It opens on sign-in; the demo must be usable from a standing start.
  await page.getByRole('link', { name: /New here\? Create an account/ }).click();
  await expect(page.getByRole('heading', { name: 'Make more good days.' })).toBeVisible();

  await page.getByLabel('Email address', { exact: true }).fill('demo@example.test');
  await page.getByLabel('Password', { exact: true }).fill('kindly-demo-1');
  await page.getByRole('button', { name: 'Create my space' }).click();
  await expect(page.getByRole('heading', { name: 'Who is here today?' })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
