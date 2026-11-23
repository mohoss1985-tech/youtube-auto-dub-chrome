import { test, expect } from './fixtures';

// Wave 0 smoke: the extension loads and its popup page opens.
// The real e2e (TED talk, first line < 5 s; Shorts does nothing) is added in Wave 1+.
test('extension loads and popup opens', async ({ context, extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('body')).toBeVisible();
});
