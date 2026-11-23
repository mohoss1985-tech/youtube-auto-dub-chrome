// B: SW synthesize with mocked fetch (headers, key never echoed) + IndexedDB LRU cache (fake-indexeddb).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { synthesize, OPENAI_TTS_URL, ELEVEN_TTS_BASE, bufToB64 } from '../../src/background/tts';
import { cacheGet, cachePut, cacheEvict, _resetCacheForTests } from '../../src/background/cache';
import { DubError } from '../../src/shared/types';

const OKEY = 'sk-test-SECRET-1234567890abcdef';
const EKEY = 'el_SECRET_abcdef1234567890';
const audio = new Uint8Array([73, 68, 51, 4, 0, 0, 1, 2, 3]);

function okFetch() {
  return vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
}

describe('synthesize', () => {
  it('OpenAI: URL, model, format, Bearer header; returns base64', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    const res = await synthesize({ text: ' Bonjour ', lang: 'fr', engine: 'openai', voice: 'nova' }, { openaiKey: OKEY });
    expect(res).toEqual({ audioB64: bufToB64(audio.buffer), mime: 'audio/mpeg' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(OPENAI_TTS_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${OKEY}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', input: 'Bonjour', voice: 'nova', response_format: 'mp3' });
    expect(url).not.toContain(OKEY);
    expect(init.body as string).not.toContain(OKEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  it('ElevenLabs: voice in path, xi-api-key header, flash model, mp3_44100_64', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await synthesize({ text: 'Merhaba', lang: 'tr', engine: 'elevenlabs', voice: 'JBFqnCBsd6RMkjVDRZzb' }, { elevenKey: EKEY });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`${ELEVEN_TTS_BASE}JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_64`);
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe(EKEY);
    expect(JSON.parse(init.body as string)).toMatchObject({ text: 'Merhaba', model_id: 'eleven_flash_v2_5', language_code: 'tr' });
    vi.unstubAllGlobals();
  });

  it('no key → NO_KEY without any fetch', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await expect(synthesize({ text: 'x', lang: 'en', engine: 'openai', voice: 'nova' }, {})).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each([
    [401, 'NO_KEY'], [429, 'RATE_LIMITED'], [500, 'ENGINE_ERROR'],
  ])('HTTP %i → %s, key never in the message, never logged', async (status, code) => {
    const log = vi.spyOn(console, 'log'), err = vi.spyOn(console, 'error'), warn = vi.spyOn(console, 'warn');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: `Incorrect API key provided: ${OKEY}. Also sk-other-abcdefgh` } }), { status })));
    const e = (await synthesize({ text: 'x', lang: 'en', engine: 'openai', voice: 'nova' }, { openaiKey: OKEY, elevenKey: EKEY })
      .then(() => undefined, (x: unknown) => x as DubError)) as DubError;
    expect(e).toBeInstanceOf(DubError);
    expect(e.code).toBe(code);
    expect(e.message).not.toContain(OKEY);
    expect(e.message).not.toContain('sk-other');
    expect(JSON.stringify(e)).not.toContain(OKEY);
    for (const s of [log, err, warn]) expect(JSON.stringify(s.mock.calls)).not.toContain(OKEY);
    vi.unstubAllGlobals();
  });

  it('network failure → NETWORK; external abort → TIMEOUT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(synthesize({ text: 'x', lang: 'en', engine: 'openai', voice: 'nova' }, { openaiKey: OKEY }))
      .rejects.toMatchObject({ code: 'NETWORK' });
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, rej) => {
      init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })));
    const ac = new AbortController();
    const p = synthesize({ text: 'x', lang: 'en', engine: 'openai', voice: 'nova' }, { openaiKey: OKEY }, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
    vi.unstubAllGlobals();
  });
});

describe('cache (IndexedDB, LRU)', () => {
  beforeEach(() => {
    (globalThis as any).indexedDB = new IDBFactory();
    _resetCacheForTests(1000);
  });

  it('round-trips lines and audio', async () => {
    await cachePut('lines', 'lines:v1:fr', [{ id: 'a', text: 'Salut' }]);
    expect(await cacheGet('lines', 'lines:v1:fr')).toEqual([{ id: 'a', text: 'Salut' }]);
    expect(await cacheGet('lines', 'missing')).toBeUndefined();
    await cachePut('audio', 'tts:1', { audioB64: 'AAAA', mime: 'audio/mpeg' });
    expect(await cacheGet('audio', 'tts:1')).toEqual({ audioB64: 'AAAA', mime: 'audio/mpeg' });
  });

  it('evicts least-recently-used audio over the cap; lines untouched', async () => {
    const big = (c: string) => ({ audioB64: c.repeat(300), mime: 'audio/mpeg' }); // ~364 bytes each
    await cachePut('lines', 'keep', [1, 2, 3]);
    await cachePut('audio', 'a', big('a'));
    await cachePut('audio', 'b', big('b'));
    await cacheGet('audio', 'a');               // a is now newer than b
    await cachePut('audio', 'c', big('c'));     // 3 × 364 > 1000 → evict b
    expect(await cacheGet('audio', 'b')).toBeUndefined();
    expect(await cacheGet('audio', 'a')).toBeDefined();
    expect(await cacheGet('audio', 'c')).toBeDefined();
    expect(await cacheGet('lines', 'keep')).toEqual([1, 2, 3]);
    await cacheEvict(0);
    expect(await cacheGet('audio', 'a')).toBeUndefined();
    expect(await cacheGet('audio', 'c')).toBeUndefined();
  });

  it('falls back to memory when IndexedDB is missing', async () => {
    delete (globalThis as any).indexedDB;
    _resetCacheForTests(1000);
    await cachePut('lines', 'k', 'v');
    expect(await cacheGet('lines', 'k')).toBe('v');
    await cachePut('audio', 'a', { audioB64: 'a'.repeat(600), mime: 'audio/mpeg' });
    await cachePut('audio', 'b', { audioB64: 'b'.repeat(600), mime: 'audio/mpeg' });
    expect(await cacheGet('audio', 'a')).toBeUndefined();
    expect(await cacheGet('audio', 'b')).toBeDefined();
  });
});
