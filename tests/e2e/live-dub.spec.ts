import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Live e2e: real YouTube video with human captions. Needs network. Run: npm run build && npx playwright test live-dub
const VIDEO = process.env.AUTODUB_VIDEO ?? 'https://www.youtube.com/watch?v=eIho2S0ZahI'; // TED, human EN captions
const LANG = process.env.AUTODUB_LANG ?? 'fr';

async function acceptConsent(page: Page) {
  const btn = page.locator('button:has-text("Accept all"), button:has-text("Tout accepter"), button[aria-label*="Accept"]').first();
  if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) await btn.click();
}

async function tabCall(ext: Page, msg: unknown) {
  return ext.evaluate(async (m) => {
    // no "tabs" permission: URLs are hidden, so pick the tab that isn't this extension page
    const me = await chrome.tabs.getCurrent();
    const tabs = await chrome.tabs.query({});
    const tab = tabs.filter((t) => t.id !== me?.id).pop()!;
    return chrome.tabs.sendMessage(tab.id!, m);
  }, msg);
}

// YouTube serves empty captions to automated Chromium (its own player shows none), so this only runs with LIVE=1.
test.skip(!process.env.LIVE, 'live YouTube test: set LIVE=1');

test('dubs a captioned video, first line < 5 s', async ({ context, extensionId }) => {
  const logs: string[] = [];
  const page = await context.newPage();
  page.on('console', (m) => { if (m.text().includes('autodub')) logs.push(m.text()); });
  await page.goto(VIDEO);
  await acceptConsent(page);
  await page.waitForSelector('video', { timeout: 30_000 });
  await page.evaluate(() => { const v = document.querySelector('video')!; v.muted = false; v.play().catch(() => {}); });
  // wait for any pre-roll ad to finish
  await page.waitForFunction(() => !document.querySelector('#movie_player')?.classList.contains('ad-showing'), null, { timeout: 60_000 });

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  await ext.evaluate(async (lang) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings as object), targetLang: lang } });
  }, LANG);

  await page.bringToFront();
  const t0 = Date.now();
  await tabCall(ext, { type: 'DUB_TOGGLE', on: true });

  let status: any;
  await expect.poll(async () => {
    status = ((await tabCall(ext, { type: 'GET_STATUS' })) as any)?.status;
    return status?.state;
  }, { timeout: 30_000, intervals: [250] }).toMatch(/dubbing|error/);
  const toDubbing = Date.now() - t0;
  console.log('STATUS', JSON.stringify(status), 'toDubbingMs', toDubbing);
  console.log('LOGS', logs.slice(-10).join('\n'));
  await page.screenshot({ path: 'screenshots/live-player.png' });

  expect(status.state, status.message).toBe('dubbing');
  await expect.poll(async () => ((await tabCall(ext, { type: 'GET_STATUS' })) as any)?.status?.currentLineId, { timeout: 15_000 }).toBeTruthy();
  const stats = await ext.evaluate(async () => (await chrome.storage.local.get('stats')).stats);
  console.log('STATS', JSON.stringify(stats));
  expect(toDubbing).toBeLessThan(5000);
});

test('Shorts page does nothing', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/shorts/');
  await page.waitForTimeout(3000);
  expect(await page.locator('.autodub-btn-host').count()).toBe(0);
});
