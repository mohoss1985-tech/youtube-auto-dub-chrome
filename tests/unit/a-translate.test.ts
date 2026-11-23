// Owner A: Translator API path, OpenAI translateBatch, pipeline fallback chain + cache.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installChromeMock } from './helpers/chrome-mock';
import type { CaptionTrack, Json3, Line } from '../../src/shared/types';
import { DubError } from '../../src/shared/types';

vi.mock('../../src/content/yt', () => ({
  getPlayerResponse: vi.fn(),
  getJson3: vi.fn(),
  bridgeRequest: vi.fn(async () => { throw new Error('no MAIN hook in tests'); }),
}));

import * as yt from '../../src/content/yt';
import { translateLocal, runTranslator } from '../../src/content/translate-local';
import { getLines, _resetPipeline, planChunks } from '../../src/content/pipeline';
import { translateBatch, parseTranslations, OPENAI_CHAT_URL } from '../../src/background/translate';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8')) as Json3;

/** Fake Translator global: availability → state; translate prefixes the target lang. */
function installTranslator(state: string, opts: { createThrows?: boolean } = {}) {
  const created: unknown[] = [];
  const T = {
    availability: vi.fn(async () => state),
    create: vi.fn(async (o: { targetLanguage: string; monitor?: (m: { addEventListener: (t: string, cb: (e: { loaded: number }) => void) => void }) => void }) => {
      if (opts.createThrows) throw new DOMException('Requires user activation', 'NotAllowedError');
      created.push(o);
      if (state !== 'available') o.monitor?.({ addEventListener: (_t, cb) => { cb({ loaded: 0.5 }); cb({ loaded: 1 }); } });
      return { translate: vi.fn(async (s: string) => `[${o.targetLanguage}] ${s}`), destroy: vi.fn() };
    }),
  };
  (globalThis as any).Translator = T;
  return T;
}

afterEach(() => { delete (globalThis as any).Translator; });

describe('translateLocal (Chrome Translator API)', () => {
  it("'downloadable' → progress → translated lines, count kept", async () => {
    const T = installTranslator('downloadable');
    const progress: number[] = [];
    const out = await translateLocal(['Hello.', '', 'Bye.'], 'en-US', 'fr', (p) => progress.push(p));
    expect(out).toEqual(['[fr] Hello.', '', '[fr] Bye.']);
    expect(progress[0]).toBe(0);
    expect(progress).toContain(0.5);
    expect(progress.at(-1)).toBe(1);
    expect(T.availability).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'fr' });
  });

  it("'unavailable' → null", async () => {
    installTranslator('unavailable');
    expect(await translateLocal(['Hi'], 'en', 'tr')).toBeNull();
  });

  it('create() refused (no user activation) → null', async () => {
    installTranslator('downloadable', { createThrows: true });
    expect(await translateLocal(['Hi'], 'en', 'ar')).toBeNull();
  });

  it('no global in this world → MAIN bridge; bridge failure → null', async () => {
    expect(await translateLocal(['Hi'], 'en', 'es')).toBeNull();
    expect(yt.bridgeRequest).toHaveBeenCalledWith('translate', { texts: ['Hi'], from: 'en', to: 'es' }, expect.any(Object));
  });

  it('runTranslator: same language is a no-op', async () => {
    const T = installTranslator('available');
    expect(await runTranslator(T as any, ['a'], 'fr-CA', 'fr')).toEqual(['a']);
    expect(T.create).not.toHaveBeenCalled();
  });
});

describe('translateBatch (OpenAI, SW)', () => {
  const KEY = 'sk-test-SECRET-123';
  let fetchMock: ReturnType<typeof vi.fn>;
  const reply = (content: unknown, status = 200) =>
    new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends a chat completion with JSON array input and returns the same count', async () => {
    fetchMock.mockResolvedValueOnce(reply({ translations: ['Bonjour.', 'Au revoir.'] }));
    const log = vi.spyOn(console, 'log');
    const out = await translateBatch(['Hello.', 'Goodbye.'], 'en', 'fr', KEY, 'gpt-4o-mini');
    expect(out).toEqual(['Bonjour.', 'Au revoir.']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(OPENAI_CHAT_URL);
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.parse(body.messages[1].content)).toEqual(['Hello.', 'Goodbye.']);
    expect(body.messages[0].content).toContain('French');
    expect(log).not.toHaveBeenCalled();
  });

  it('retries once on a line-count mismatch, then NO_TRANSLATION', async () => {
    fetchMock.mockResolvedValueOnce(reply({ translations: ['only one'] })).mockResolvedValueOnce(reply({ translations: ['a', 'b'] }));
    expect(await translateBatch(['x', 'y'], 'en', 'es', KEY, 'm')).toEqual(['a', 'b']);
    fetchMock.mockResolvedValue(reply({ translations: ['only one'] }));
    await expect(translateBatch(['x', 'y'], 'en', 'es', KEY, 'm')).rejects.toMatchObject({ code: 'NO_TRANSLATION' });
  });

  it('maps 401 → NO_KEY, 429 → RATE_LIMITED, never echoes the key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`{"error":{"message":"Incorrect API key provided: ${KEY}"}}`, { status: 401 }));
    const e = await translateBatch(['x'], 'en', 'fr', KEY, 'm').catch((x) => x);
    expect(e).toBeInstanceOf(DubError);
    expect(e.code).toBe('NO_KEY');
    expect(String(e.message)).not.toContain(KEY);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(translateBatch(['x'], 'en', 'fr', KEY, 'm')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(translateBatch(['x'], 'en', 'fr', '', 'm')).rejects.toMatchObject({ code: 'NO_KEY' });
  });

  it('parseTranslations accepts object, bare array, fenced JSON', () => {
    expect(parseTranslations('{"translations":["a"]}')).toEqual(['a']);
    expect(parseTranslations('["a","b"]')).toEqual(['a', 'b']);
    expect(parseTranslations('```json\n{"out":["a"]}\n```')).toEqual(['a']);
    expect(parseTranslations('nope')).toBeNull();
  });
});

describe('getLines pipeline + fallback chain', () => {
  const human: CaptionTrack = { baseUrl: 'https://www.youtube.com/api/timedtext?v=vid&lang=en', languageCode: 'en', vssId: '.en' };
  const asr: CaptionTrack = { baseUrl: 'https://www.youtube.com/api/timedtext?v=vid&lang=en&kind=asr', languageCode: 'en', vssId: 'a.en', kind: 'asr' };
  let chromeMock: ReturnType<typeof installChromeMock>;
  let swTranslate: (texts: string[]) => unknown;
  let cache: Map<string, unknown>;

  const pr = (tracks: CaptionTrack[]) => ({ videoDetails: { videoId: 'vid' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks, translationLanguages: [{ languageCode: 'fr' }, { languageCode: 'ar' }] } } });

  beforeEach(() => {
    _resetPipeline();
    cache = new Map();
    swTranslate = () => ({ ok: false, error: 'NO_KEY', message: 'Add an OpenAI key' });
    chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: any) => {
      if (msg.type === 'CACHE_GET') return cache.has(msg.key) ? { ok: true, value: cache.get(msg.key) } : { ok: true };
      if (msg.type === 'CACHE_PUT') { cache.set(msg.key, msg.value); return { ok: true }; }
      if (msg.type === 'TRANSLATE') return swTranslate(msg.texts);
      return undefined;
    });
    vi.mocked(yt.getPlayerResponse).mockReset();
    vi.mocked(yt.getJson3).mockReset();
  });

  it('track already in target → no translation, cached under lines:<id>:<lang>', async () => {
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr([human]) as any);
    vi.mocked(yt.getJson3).mockResolvedValue(fx('json3-human-en.json'));
    const progress: string[] = [];
    const lines = await getLines('vid', 'en', (m) => progress.push(m));
    expect(lines[0]!.text).toBe('Hello everyone, and welcome to our garden.');
    expect(lines[0]!.gender).toBe('female');
    expect(cache.get('lines:vid:en')).toEqual(lines);
    expect(yt.getJson3).toHaveBeenCalledTimes(1);
    expect(progress[0]).toBe('Loading captions…');
    // second call: cache hit, no YouTube work
    vi.mocked(yt.getPlayerResponse).mockClear();
    expect(await getLines('vid', 'en')).toEqual(lines);
    expect(yt.getPlayerResponse).not.toHaveBeenCalled();
  });

  it('human track: tlang first', async () => {
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr([human]) as any);
    vi.mocked(yt.getJson3).mockImplementation(async (_t, _v, tlang) =>
      tlang === 'fr' ? { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Bonjour à tous.' }] }] } : fx('json3-human-en.json'));
    const lines = await getLines('vid', 'fr');
    expect(lines.map((l) => l.text)).toEqual(['Bonjour à tous.']);
    expect(yt.getJson3).toHaveBeenCalledWith(human, 'vid', 'fr');
  });

  it('tlang 429 → Translator API (merge before translate, keeps source + gender, progress text)', async () => {
    installTranslator('downloadable');
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr([human]) as any);
    vi.mocked(yt.getJson3).mockImplementation(async (_t, _v, tlang) => {
      if (tlang) throw new DubError('RATE_LIMITED');
      return fx('json3-human-en.json');
    });
    const progress: string[] = [];
    const lines = await getLines('vid', 'fr', (m) => progress.push(m));
    expect(lines[0]).toMatchObject({ text: '[fr] Hello everyone, and welcome to our garden.', source: 'Hello everyone, and welcome to our garden.', gender: 'female' });
    expect(lines).toHaveLength(7);
    expect(progress.some((m) => /^Downloading French translator… 50%$/.test(m))).toBe(true);
    expect(cache.get('lines:vid:fr')).toEqual(lines);
  });

  it('ASR track: Translator API before tlang', async () => {
    installTranslator('available');
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr([asr]) as any);
    vi.mocked(yt.getJson3).mockResolvedValue(fx('json3-asr-en.json'));
    const lines = await getLines('vid', 'ar');
    expect(lines[0]!.text).toBe('[ar] so today we are going to build a little robot with cardboard');
    expect(yt.getJson3).toHaveBeenCalledTimes(1); // no tlang call
  });

  it('Translator unavailable → OpenAI via SW (batches ≤ 40)', async () => {
    installTranslator('unavailable');
    const many: Json3 = { events: Array.from({ length: 90 }, (_, i) => ({ tStartMs: i * 3000, dDurationMs: 2000, segs: [{ utf8: `Line ${i}.` }] })) };
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr([{ ...human, isTranslatable: false } as CaptionTrack]) as any);
    vi.mocked(yt.getJson3).mockResolvedValue(many);
    const sizes: number[] = [];
    swTranslate = (texts) => { sizes.push(texts.length); return { ok: true, texts: texts.map((t) => `T:${t}`) }; };
    const lines = await getLines('vid', 'tr');
    expect(lines).toHaveLength(90);
    expect(lines[89]).toMatchObject({ text: 'T:Line 89.', source: 'Line 89.' });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(40);
    expect(yt.getJson3).toHaveBeenCalledTimes(1); // isTranslatable:false → no tlang
  });

  it('nothing available → NO_TRANSLATION with a helpful message', async () => {
    installTranslator('unavailable');
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr([asr]) as any);
    vi.mocked(yt.getJson3).mockImplementation(async (_t, _v, tlang) => (tlang ? null : fx('json3-asr-en.json')));
    const e = await getLines('vid', 'fr').catch((x) => x);
    expect(e).toBeInstanceOf(DubError);
    expect(e.code).toBe('NO_TRANSLATION');
    expect(e.message).toMatch(/OpenAI key/);
  });

  it('no tracks / empty json3 → NO_CAPTIONS', async () => {
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr([]) as any);
    await expect(getLines('vid', 'fr')).rejects.toMatchObject({ code: 'NO_CAPTIONS' });
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr([human]) as any);
    vi.mocked(yt.getJson3).mockResolvedValue(null);
    await expect(getLines('vid', 'en')).rejects.toMatchObject({ code: 'NO_CAPTIONS' });
  });

  it('progressive mode: resolves after the first chunk from fromTime, then onUpdate to complete; cached at the end', async () => {
    installTranslator('available');
    const many: Json3 = { events: Array.from({ length: 150 }, (_, i) => ({ tStartMs: i * 3000, dDurationMs: 2000, segs: [{ utf8: `L${i}.` }] })) };
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr([asr]) as any);
    vi.mocked(yt.getJson3).mockResolvedValue(many);
    const updates: Line[][] = [];
    const done = new Promise<void>((resolve) => {
      const first = getLines('vid', 'es', undefined, { fromTime: 300, onUpdate: (l) => { updates.push(l); if (l.length === 150) resolve(); } });
      void first.then((lines) => {
        expect(lines).toHaveLength(40);
        expect(lines[0]!.source).toBe('L100.'); // 300 s → line 100
      });
    });
    await done;
    await new Promise((r) => setTimeout(r, 0));
    expect(updates.at(-1)!.map((l) => l.source)).toEqual(Array.from({ length: 150 }, (_, i) => `L${i}.`));
    expect((cache.get('lines:vid:es') as Line[]).length).toBe(150);
  });

  it('planChunks order: forward from fromTime, then the start', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, start: i, end: i + 1, text: 'x' }));
    expect(planChunks(lines, 5, 2, 3)).toEqual([[4, 6], [6, 9], [9, 10], [0, 3], [3, 4]]);
  });
});
