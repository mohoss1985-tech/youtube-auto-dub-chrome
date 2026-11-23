// D: popup screenshots in every state → screenshots/popup-<state>.png
// Build first:  node build.mjs --outdir build-d   then   EXT_DIR=build-d npx playwright test popup-screenshots
import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EXT_DIR = path.resolve(process.env.EXT_DIR ?? 'dist');
const OUT = path.resolve('screenshots');
const STATES = ['idle', 'preparing', 'dubbing', 'paused-ad', 'error', 'not-youtube', 'engine-open', 'dark', 'loading', 'empty', 'official'] as const;

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) throw new Error(`No build at ${EXT_DIR}`);
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodub-shots-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    deviceScaleFactor: 2,
    viewport: { width: 340, height: 600 },
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => { await context?.close(); });

for (const state of STATES) {
  test(`popup ${state}`, async () => {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: state === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' });
    await page.goto(`chrome-extension://${extensionId}/popup.html?mock=${state}`);
    await expect(page.locator('#app[data-ready="true"]')).toBeVisible();
    if (state !== 'loading') await expect(page.locator('[data-skeleton]')).toHaveCount(0);
    await page.waitForTimeout(150);
    const box = await page.locator('body').boundingBox();
    await page.screenshot({
      path: path.join(OUT, `popup-${state}.png`),
      clip: { x: 0, y: 0, width: 340, height: Math.ceil(box!.height) },
      fullPage: true,
      animations: 'disabled',
    });
    await page.close();
  });
}
