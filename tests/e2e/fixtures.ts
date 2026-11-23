import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** Absolute path of the unpacked extension (override with AUTODUB_DIST). */
export const DIST = path.resolve(process.env.AUTODUB_DIST ?? 'dist');

/**
 * Fixtures: `context` is a persistent Chromium context with dist/ loaded;
 * `extensionId` is read from the service worker URL.
 * Headless by default (new headless supports extensions); HEADED=1 for a window.
 */
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
      throw new Error(`No build at ${DIST}. Run "npm run build" first.`);
    }
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodub-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--autoplay-policy=no-user-gesture-required'],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(new URL(sw.url()).host);
  },
});

export const expect = test.expect;
