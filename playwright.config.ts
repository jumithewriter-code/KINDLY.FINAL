import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    // `chromium` uses Playwright's own download. In an environment where that
    // download is unavailable, set KINDLY_BROWSER_CHANNEL=chrome (or msedge) to
    // drive an already-installed system browser instead.
    channel: process.env.KINDLY_BROWSER_CHANNEL ?? 'chromium',
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Video needs a separate ffmpeg download; traces are enough for diagnosis.
    video: 'off',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /responsive\.spec\.ts/ },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: {
    // The e2e suite runs against the deterministic in-memory backend so that CI
    // never depends on a live Supabase project. See docs/architecture.md.
    command: 'npm run build && npm run preview',
    port: PORT,
    reuseExistingServer: !process.env.CI,
    env: { VITE_KINDLY_BACKEND: 'memory', VITE_KINDLY_E2E: 'true' },
    timeout: 180_000,
  },
});
