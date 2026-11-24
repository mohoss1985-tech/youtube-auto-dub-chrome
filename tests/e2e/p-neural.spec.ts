// P (v1.1): neural voices end to end: popup page → SW → offscreen document → Piper worker → WAV.
// Run: node build.mjs --outdir build-p && AUTODUB_DIST=build-p npx playwright test tests/e2e/p-neural.spec.ts
// Models: served from $PIPER_MODELS (local .onnx/.onnx.json files) when set, else downloaded from huggingface.co.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';

const MODELS_DIR = process.env.PIPER_MODELS;
const TEXT = "Salut tout le monde, aujourd'hui on va construire la plus grande maison du monde entier !"; // 15 words

test('neural French voice: download, synthesize, RTF < 0.3', async ({ context, extensionId }) => {
  test.setTimeout(240_000);
  if (MODELS_DIR) {
    await context.route(/huggingface\.co\/.*\/([a-zA-Z_]+-[a-z_]+-(?:x_low|low|medium|high)\.onnx(?:\.json)?)$/, (route) => {
      const f = path.join(MODELS_DIR, route.request().url().split('/').pop()!);
      if (!fs.existsSync(f)) return route.fallback();
      return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'Access-Control-Allow-Origin': '*', 'Content-Length': String(fs.statSync(f).size) } });
    });
  }
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?mock=idle`);
  const out = await page.evaluate(async (text) => {
    const send = (m: unknown) => chrome.runtime.sendMessage(m) as Promise<any>;
    const models = ['fr_FR-siwis-medium', 'fr_FR-tom-medium'];
    // Before download: NEURAL_TTS answers "pending" (Web Speech plays meanwhile) and starts the download.
    const first = await send({ type: 'NEURAL_TTS', text, lang: 'fr', voice: 'fr_FR-siwis-medium' });
    let st: any = await send({ type: 'NEURAL_STATUS', models, download: models });
    const seen: number[] = [];
    for (let i = 0; i < 400 && !(st.ok && st.models.every((m: any) => m.ready)); i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = await send({ type: 'NEURAL_STATUS', models });
      for (const m of st.models ?? []) if (m.progress !== undefined) seen.push(m.progress);
      if (st.models?.some((m: any) => m.error)) break;
    }
    const res: Record<string, any> = {};
    for (const voice of ['fr_FR-siwis-medium', 'fr_FR-tom-medium']) {
      await send({ type: 'NEURAL_TTS', text: 'Bonjour.', lang: 'fr', voice }); // warm (loads the model)
      const r = await send({ type: 'NEURAL_TTS', text, lang: 'fr', voice });
      res[voice] = { ok: r.ok, ms: r.ms, rtf: r.rtf, threads: r.threads, bytes: r.audioB64 ? atob(r.audioB64).length : 0, head: r.audioB64?.slice(0, 6) };
    }
    const ready = (await chrome.storage.local.get('neuralReady')).neuralReady;
    return { first, st, seenProgress: seen.length, res, ready };
  }, TEXT);
  console.log('[p-neural]', JSON.stringify(out.res));
  expect(out.first.ok).toBe(true);
  expect(out.first.pending ?? false).toBe(true);
  expect(out.st.models.every((m: { ready: boolean }) => m.ready)).toBe(true);
  expect(out.ready).toEqual(expect.arrayContaining(['fr_FR-siwis-medium', 'fr_FR-tom-medium']));
  for (const r of Object.values(out.res) as { ok: boolean; ms: number; rtf: number; head: string }[]) {
    expect(r.ok).toBe(true);
    expect(r.head.slice(0, 5)).toBe('UklGR'); // "RIFF"
    expect(r.ms).toBeGreaterThan(2500);
    expect(r.ms).toBeLessThan(8000);
    expect(r.rtf).toBeLessThan(0.3);
  }
});

test('popup shows the neural engine with Male/Female voices', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?mock=idle`);
  await page.locator('[data-el="engine"] summary').click();
  await page.locator('input[name="engine"][value="neural"]').check();
  await expect(page.locator('[data-neural]')).toBeVisible();
  await expect(page.locator('[data-neural-voice="fr_FR-siwis-medium"]')).toContainText('Female');
  await expect(page.locator('[data-neural-voice="fr_FR-upmc-medium#pierre"]')).toContainText('Male'); // v1.2.2 (M): Pierre = default male
  await expect(page.locator('.eng-rec')).toHaveText('Recommended for French');
});
