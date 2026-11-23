import { defineConfig } from '@playwright/test';

/**
 * E2E config. Tests load the unpacked extension from dist/ through
 * chromium.launchPersistentContext (see tests/e2e/fixtures.ts).
 * Run `npm run build` first. HEADED=1 shows the browser window.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
