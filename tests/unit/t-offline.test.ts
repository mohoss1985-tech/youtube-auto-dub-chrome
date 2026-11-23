// T (v1.2.1): free offline translation — chain order, tlang retry window, download progress plumbing, cache key, SW batching.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import { DubError, type CaptionTrack, type Json3, type Line } from '../../src/shared/types';

vi.mock('../../src/content/yt', () => ({
  getPlayerResponse: vi.fn(),
  getJson3: vi.fn(),
  // No Translator global in the page either (owner's managed Chrome): the MAIN-world fallback fails.
  bridgeRequest: vi.fn(async () => { throw new Error('Translator is not defined'); }),
}));

import * as yt from '../../src/content/yt';
import { getLines, _resetPipeline, _offlineTiming, cacheKey, evenBatches, noTranslationMessage, TLANG_RETRY_MS } from '../../src/content/pipeline';
import { offlineRoute, OPUS_MODELS, OFFLINE_BATCH } from '../../src/shared/offline-mt';
import { onOfflineTranslate } from '../../src/background/offline';
import { OFFSCREEN_TARGET } from '../../src/offscreen/protocol';

const ev = (t: number, d: number, s: string) => ({ tStartMs: t, dDurationMs: d, segs: [{ utf8: s }] });
const SRC: Json3 = { events: [ev(0, 2000, '>> I JUST BOUGHT A PRIVATE ISLAND!'), ev(2500, 2000, 'It cost $500,000.'), ev(5000, 2000, 'No way.')] };
const human: CaptionTrack = { baseUrl: 'https://www.youtube.com/api/timedtext?v=vid&lang=en', languageCode: 'en', vssId: '.en' };
const pr = (track: CaptionTrack = human) => ({ videoDetails: { videoId: 'vid' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [track], translationLanguages: [{ languageCode: 'fr' }] } } });

describe('offline catalog', () => {
  it('direct pairs, English pivot, en→tr skipped (530 MB only)', () => {
    expect(offlineRoute('en-US', 'fr')!.map((m) => m.repo)).toEqual(['Xenova/opus-mt-en-fr']);
    expect(offlineRoute('fr', 'es')!.map((m) => m.repo)).toEqual(['Xenova/opus-mt-fr-en', 'Xenova/opus-mt-en-es']);
    expect(offlineRoute('tr', 'en')!.map((m) => m.repo)).toEqual(['Xenova/opus-mt-tr-en']);
    expect(offlineRoute('en', 'tr')).toBeNull();
    expect(offlineRoute('de', 'fr')).toBeNull();
    expect(offlineRoute('fr', 'fr')).toEqual([]);
    expect(Object.keys(OPUS_MODELS).sort()).toEqual(['ar-en', 'en-ar', 'en-es', 'en-fr', 'es-en', 'fr-en', 'tr-en']);
  });
  it('evenBatches: ≤ 16, even split', () => {
    expect(evenBatches(20, 16)).toEqual([[0, 10], [10, 20]]);
    expect(evenBatches(16, 16)).toEqual([[0, 16]]);
    expect(evenBatches(33, 16)).toEqual([[0, 11], [11, 22], [22, 33]]);
    expect(evenBatches(0, 16)).toEqual([]);
  });
  it('lines cache key bumped to :4', () => {
    expect(cacheKey('vid', 'fr')).toBe('lines:vid:fr:4');
  });
});

describe('getLines chain with offline translation', () => {
  let cache: Map<string, unknown>;
  let sent: any[];
  let offline: (msg: any) => unknown;
  let openai: (msg: any) => unknown;

  beforeEach(() => {
    _resetPipeline();
    _offlineTiming.pollMs = 1;
    cache = new Map();
    sent = [];
    offline = (m) => ({ ok: true, texts: m.texts.map((t: string) => `FR(${t})`), engine: 'opus-mt' });
    openai = () => ({ ok: false, error: 'NO_KEY', message: 'Add an OpenAI key' });
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: any) => {
      sent.push(msg);
      if (msg.type === 'CACHE_GET') return cache.has(msg.key) ? { ok: true, value: cache.get(msg.key) } : { ok: true };
      if (msg.type === 'CACHE_PUT') { cache.set(msg.key, msg.value); return { ok: true }; }
      if (msg.type === 'OFFLINE_TRANSLATE') return offline(msg);
      if (msg.type === 'TRANSLATE') return openai(msg);
      return undefined;
    });
    vi.mocked(yt.getPlayerResponse).mockReset().mockResolvedValue(pr() as any);
    vi.mocked(yt.getJson3).mockReset().mockImplementation(async (_t, _v, tlang) => {
      if (tlang) throw new DubError('RATE_LIMITED');
      return SRC;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); _offlineTiming.pollMs = 700; });

  it('tlang 429 → Translator missing (page) → Opus-MT used; flags, source, polish kept; cached under :4; OpenAI never asked', async () => {
    const lines = await getLines('vid', 'fr');
    expect(yt.getJson3).toHaveBeenCalledWith(human, 'vid', 'fr'); // tlang tried first
    expect(yt.bridgeRequest).toHaveBeenCalledWith('translate', expect.anything(), expect.anything()); // page Translator tried
    const types = sent.map((m) => m.type);
    expect(types).toContain('OFFLINE_TRANSLATE');
    expect(types).not.toContain('TRANSLATE');
    expect(lines.map((l) => l.source)).toEqual(['I just bought a private island!', 'It cost $500,000.', 'That is impossible.']);
    expect(lines[0]).toMatchObject({ text: 'FR(I just bought a private island!)', shout: true, newSpeaker: true });
    expect(cache.get('lines:vid:fr:4')).toEqual(lines);
    const off = sent.find((m) => m.type === 'OFFLINE_TRANSLATE');
    expect(off).toMatchObject({ from: 'en', to: 'fr' });
    expect(off.texts.length).toBeLessThanOrEqual(16);
  });

  it('download progress: pending answers → "Downloading French translator (offline, once)… 40%", then translates', async () => {
    let calls = 0;
    offline = (m) => {
      calls++;
      if (calls === 1) return { ok: true, pending: true, progress: 0 };
      if (calls === 2) return { ok: true, pending: true, progress: 0.4 };
      return { ok: true, texts: m.texts.map((t: string) => `FR(${t})`), engine: 'opus-mt' };
    };
    const progress: string[] = [];
    const lines = await getLines('vid', 'fr', (m) => progress.push(m));
    expect(progress).toContain('Downloading French translator (offline, once)… 0%');
    expect(progress).toContain('Downloading French translator (offline, once)… 40%');
    expect(progress.at(-1)).toBe('Translating to French (offline)…');
    expect(lines).toHaveLength(3);
  });

  it('progressive: first ~20 lines from the current time come first, in ≤ 16-line requests', async () => {
    const many: Json3 = { events: Array.from({ length: 100 }, (_, i) => ev(i * 3000, 2000, `Line ${i}.`)) };
    vi.mocked(yt.getJson3).mockImplementation(async (_t, _v, tlang) => { if (tlang) throw new DubError('RATE_LIMITED'); return many; });
    const updates: Line[][] = [];
    let first: Line[] = [];
    await new Promise<void>((resolve) => {
      void getLines('vid', 'fr', undefined, { fromTime: 150, onUpdate: (l) => { updates.push(l); if (l.length === 100) resolve(); } }).then((l) => { first = l; });
    });
    expect(first).toHaveLength(20);
    expect(first[0]!.source).toBe('Line 50.');
    const sizes = sent.filter((m) => m.type === 'OFFLINE_TRANSLATE').map((m) => m.texts.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(16);
    expect(sizes.slice(0, 2)).toEqual([10, 10]);
    await new Promise((r) => setTimeout(r, 0));
    expect((cache.get(cacheKey('vid', 'fr')) as Line[]).length).toBe(100);
  });

  it('a tlang 429 does not poison later attempts: blocked for 10 min, then one retry', async () => {
    offline = () => ({ ok: false, error: 'ENGINE_ERROR', message: 'HTTP 403' }); // nothing cached → each getLines runs the chain
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const tl = () => vi.mocked(yt.getJson3).mock.calls.filter((c) => c[2]).length;
    await getLines('vid', 'fr').catch(() => {});
    expect(tl()).toBe(1);
    now += 60_000;
    await getLines('vid', 'fr').catch(() => {});
    expect(tl()).toBe(1); // still inside the window
    now += TLANG_RETRY_MS;
    vi.mocked(yt.getJson3).mockImplementation(async (_t, _v, tlang) => (tlang ? { events: [ev(0, 1000, 'Bonjour à tous.')] } : SRC));
    const lines = await getLines('vid', 'fr');
    expect(tl()).toBe(2);
    expect(lines.map((l) => l.text)).toEqual(['Bonjour à tous.']);
  });

  it('offline unavailable → OpenAI key used when set', async () => {
    offline = () => ({ ok: false, error: 'ENGINE_ERROR', message: 'HTTP 403' });
    openai = (m) => ({ ok: true, texts: m.texts.map((t: string) => `OA(${t})`) });
    const lines = await getLines('vid', 'fr');
    expect(lines[0]!.text).toBe('OA(I just bought a private island!)');
  });

  it('everything fails → accurate message (download problem, not "update Chrome")', async () => {
    offline = () => ({ ok: false, error: 'ENGINE_ERROR', message: 'Offline translator download failed: HTTP 403' });
    const e = await getLines('vid', 'fr').catch((x) => x);
    expect(e.code).toBe('NO_TRANSLATION');
    expect(e.message).toMatch(/offline English → French translator could not be loaded/);
    expect(e.message).toMatch(/huggingface\.co/);
    expect(e.message).toMatch(/OpenAI key/);
    expect(e.message).not.toMatch(/update Chrome/i);
  });

  it('no offline model for the pair → no OFFLINE_TRANSLATE call, says so', async () => {
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr({ ...human, languageCode: 'de', isTranslatable: false } as CaptionTrack) as any);
    const e = await getLines('vid', 'fr').catch((x) => x);
    expect(sent.some((m) => m.type === 'OFFLINE_TRANSLATE')).toBe(false);
    expect(e.message).toBe(noTranslationMessage('de', 'fr', false, null, { error: 'NO_KEY' }));
    expect(e.message).toMatch(/no free offline de → French translator/);
  });
});

describe('SW OFFLINE_TRANSLATE → offscreen', () => {
  let chromeMock: ReturnType<typeof installChromeMock>;
  let reqs: any[];
  beforeEach(() => {
    chromeMock = installChromeMock();
    reqs = [];
    (chromeMock.runtime as any).getContexts = vi.fn(async () => [{}]); // offscreen document already open
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: any) => {
      expect(msg.target).toBe(OFFSCREEN_TARGET);
      reqs.push(msg.req);
      return { ok: true, texts: msg.req.texts.map((t: string) => `fr:${t}`), engine: 'opus-mt', computeMs: 5 };
    });
  });

  it('splits into ≤ 16-line batches and keeps order', async () => {
    const texts = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const r = await onOfflineTranslate({ type: 'OFFLINE_TRANSLATE', texts, from: 'en', to: 'fr' });
    expect(r.ok && r.texts).toEqual(texts.map((t) => `fr:${t}`));
    expect(reqs.map((q) => q.texts.length)).toEqual([OFFLINE_BATCH, OFFLINE_BATCH, 8]);
    expect(reqs[0]).toMatchObject({ op: 'mt', from: 'en', to: 'fr' });
  });

  it('pending (model downloading) is passed through with progress + size', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({ ok: true, pending: true, progress: 0.4, sizeMB: 109 }));
    const r = await onOfflineTranslate({ type: 'OFFLINE_TRANSLATE', texts: ['Hi'], from: 'en', to: 'fr' });
    expect(r).toEqual({ ok: true, pending: true, progress: 0.4, sizeMB: 109 });
  });

  it('offscreen errors map to NO_TRANSLATION / ENGINE_ERROR', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({ ok: false, code: 'NO_TRANSLATION', message: 'No offline model for de → fr' }));
    expect(await onOfflineTranslate({ type: 'OFFLINE_TRANSLATE', texts: ['x'], from: 'de', to: 'fr' })).toMatchObject({ ok: false, error: 'NO_TRANSLATION' });
    chromeMock.runtime.sendMessage.mockImplementation(async () => undefined);
    expect(await onOfflineTranslate({ type: 'OFFLINE_TRANSLATE', texts: ['x'], from: 'en', to: 'fr' })).toMatchObject({ ok: false, error: 'ENGINE_ERROR' });
  });
});
