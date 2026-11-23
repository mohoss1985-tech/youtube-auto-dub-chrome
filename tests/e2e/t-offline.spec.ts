// T (v1.2.1): free offline translation end to end: extension page → SW (OFFLINE_TRANSLATE) → offscreen → Opus-MT worker.
// Run: node build.mjs --outdir build-t && AUTODUB_DIST=build-t npx playwright test tests/e2e/t-offline.spec.ts
// Downloads Xenova/opus-mt-en-fr (q8, ~109 MB) from huggingface.co on the first run of a fresh profile.
import fs from 'node:fs';
import { test, expect } from './fixtures';

/** 20 MrBeast / NBA-style lines (already through F's cleanup: no fillers, sentence case). */
export const LINES = [
  'I just bought a private island!',
  'Whoever stays in the circle the longest wins $500,000.',
  'No way, he actually did it.',
  'Chandler, you have ten seconds to grab as much money as you can.',
  'This is the most expensive pizza in the world.',
  'If you subscribe, you could win a brand new car.',
  'We hid a key somewhere in this house.',
  'Karl is about to get eliminated.',
  'I cannot believe this is real.',
  'LeBron James just scored his 40,000th point.',
  'The Lakers are down by three with ten seconds left.',
  'Steph Curry pulls up from half court and it is good!',
  'That was the craziest game I have ever seen.',
  'He dunked right over two defenders.',
  'The rookie had 30 points and 12 rebounds tonight.',
  'Everyone in the stadium is going wild.',
  'Last to leave the pool wins.',
  'Give it up for the winner!',
  'We built a giant maze in our backyard.',
  'You only have one hour left, so hurry up.',
];

test('offline en→fr: download with progress, then translate 20 lines', async ({ context, extensionId }) => {
  test.setTimeout(900_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?mock=idle`);
  if (process.env.T_ALL) await page.evaluate(() => { (globalThis as any).__T_ALL = true; });
  const out = await page.evaluate(async (lines) => {
    const send = (m: unknown) => chrome.runtime.sendMessage(m) as Promise<any>;
    const t0 = performance.now();
    const seen: number[] = [];
    let r: any;
    for (let i = 0; i < 3000; i++) {
      r = await send({ type: 'OFFLINE_TRANSLATE', texts: ['Hello.'], from: 'en', to: 'fr' });
      if (!r.ok || !r.pending) break;
      seen.push(r.progress);
      await new Promise((x) => setTimeout(x, 300));
    }
    const downloadMs = performance.now() - t0;
    const warm = r;
    // 20 lines, as the pipeline sends them: two batches of 10.
    const t1 = performance.now();
    const a = await send({ type: 'OFFLINE_TRANSLATE', texts: lines.slice(0, 10), from: 'en', to: 'fr' });
    const tFirst = performance.now() - t1;
    const b = await send({ type: 'OFFLINE_TRANSLATE', texts: lines.slice(10), from: 'en', to: 'fr' });
    const total = performance.now() - t1;
    // One at a time (latency of a single line).
    const t2 = performance.now();
    const one = await send({ type: 'OFFLINE_TRANSLATE', texts: [lines[0]], from: 'en', to: 'fr' });
    const oneMs = performance.now() - t2;
    // Unsupported pair → clean NO_TRANSLATION.
    const no = await send({ type: 'OFFLINE_TRANSLATE', texts: ['Hallo'], from: 'de', to: 'fr' });
    // What landed in the extension-origin cache (= the one-time download).
    const cache = await caches.open('autodub-mt-v1');
    const cached: Record<string, number> = {};
    for (const req of await cache.keys()) cached[req.url.split('/').slice(-2).join('/')] = (await (await cache.match(req))!.blob()).size;
    // Other pairs (optional, T_ALL=1): first-use latency incl. download, and samples.
    const others: Record<string, unknown> = {};
    if ((globalThis as any).__T_ALL) {
      for (const to of ['es', 'ar']) {
        const s = performance.now();
        let x: any;
        for (let i = 0; i < 3000; i++) {
          x = await send({ type: 'OFFLINE_TRANSLATE', texts: lines.slice(0, 5), from: 'en', to });
          if (!x.ok || !x.pending) break;
          await new Promise((y) => setTimeout(y, 300));
        }
        others[to] = { ms: Math.round(performance.now() - s), ok: x.ok, texts: x.texts, error: x.message };
      }
    }
    return { downloadMs, seen, warm, a, b, tFirst, total, one, oneMs, no, cached, others };
  }, LINES);
  const texts = [...(out.a.texts ?? []), ...(out.b.texts ?? [])];
  const report = {
    downloadMs: Math.round(out.downloadMs), cachedMB: +(Object.values(out.cached as Record<string, number>).reduce((x, y) => x + y, 0) / 1e6).toFixed(1), cached: out.cached, others: out.others,
    progressSamples: out.seen.length, progressMax: Math.max(0, ...out.seen),
    engine: out.a.engine, first10Ms: Math.round(out.tFirst), all20Ms: Math.round(out.total), msPerLine: Math.round(out.total / 20),
    singleLineMs: Math.round(out.oneMs), no: out.no,
    pairs: LINES.map((l, i) => [l, texts[i]]),
  };
  console.log('[t-offline]', JSON.stringify(report, null, 1));
  if (process.env.T_REPORT) fs.writeFileSync(process.env.T_REPORT, JSON.stringify(report, null, 1));
  expect(out.warm.ok).toBe(true);
  expect(out.warm.texts?.[0]).toMatch(/bonjour/i);
  expect(out.seen.length).toBeGreaterThan(0);
  expect(texts).toHaveLength(20);
  expect(texts.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
  expect(out.no.ok).toBe(false);
  expect(out.no.error).toBe('NO_TRANSLATION');
});
