// B: base64 → Blob, AudioEngine (mocked SW), WebSpeechEngine (fake speechSynthesis), createEngine.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import { AudioEngine, b64ToBlob, MAX_CONCURRENT } from '../../src/content/voice/audio';
import { WebSpeechEngine, splitText, watchdogMs } from '../../src/content/voice/webspeech';
import { createEngine } from '../../src/content/voice/engine';
import { DubError, type Line } from '../../src/shared/types';

const line = (id: string, text = 'Bonjour à tous.'): Line => ({ id, start: 0, end: 2, text });

describe('b64ToBlob', () => {
  it('round-trips bytes and keeps the mime type', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 73, 68, 51]);
    const b64 = btoa(String.fromCharCode(...bytes));
    const blob = b64ToBlob(b64, 'audio/mpeg');
    expect(blob.type).toBe('audio/mpeg');
    expect(blob.size).toBe(bytes.length);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
});

describe('createEngine', () => {
  it('maps ids to engines', () => {
    expect(createEngine('webspeech')).toBeInstanceOf(WebSpeechEngine);
    expect(createEngine('openai')).toBeInstanceOf(AudioEngine);
    expect(createEngine('elevenlabs').id).toBe('elevenlabs');
  });
});

describe('AudioEngine', () => {
  let urls: string[];
  beforeEach(() => {
    installChromeMock();
    urls = [];
    let n = 0;
    (URL as any).createObjectURL = vi.fn(() => { const u = `blob:x/${n++}`; urls.push(u); return u; });
    (URL as any).revokeObjectURL = vi.fn();
  });

  it('prepare: sends TTS, builds a Blob URL, knownMs from probe, dedupes', async () => {
    const send = vi.fn(async () => ({ ok: true as const, audioB64: btoa('abc'), mime: 'audio/mpeg' }));
    const eng = new AudioEngine('openai', { send, probe: async () => 1234 });
    const [p, p2] = await Promise.all([eng.prepare(line('1'), 'fr', 'nova'), eng.prepare(line('1'), 'fr', 'nova')]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([{ type: 'TTS', text: 'Bonjour à tous.', lang: 'fr', engine: 'openai', voice: 'nova' }]);
    expect(p).toBe(p2);
    expect(p.url).toMatch(/^blob:/);
    expect(p.knownMs).toBe(1234);
    expect(p.engine).toBe('openai');
    expect(await eng.prepare(line('1'), 'fr', 'nova')).toBe(p); // memoised
  });

  it('limits concurrent TTS requests to 3', async () => {
    let active = 0, peak = 0;
    const send = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { ok: true as const, audioB64: btoa('x'), mime: 'audio/mpeg' };
    });
    const eng = new AudioEngine('elevenlabs', { send, probe: async () => 100 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => eng.prepare(line(String(i)), 'en')));
    expect(send).toHaveBeenCalledTimes(10);
    expect(peak).toBe(MAX_CONCURRENT);
  });

  it('error → throws DubError and signals fallback once', async () => {
    const onFallback = vi.fn();
    const send = vi.fn(async () => ({ ok: false as const, error: 'NO_KEY' as const, message: 'Add key' }));
    const eng = new AudioEngine('openai', { send, onFallback });
    await expect(eng.prepare(line('1'), 'fr')).rejects.toBeInstanceOf(DubError);
    await expect(eng.prepare(line('2'), 'fr')).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0].code).toBe('NO_KEY');
  });

  it('play sets rate/volume, ends, stopAll stops; dispose revokes URLs', async () => {
    const send = vi.fn(async () => ({ ok: true as const, audioB64: btoa('x'), mime: 'audio/mpeg' }));
    const eng = new AudioEngine('openai', { send, probe: async () => 500 });
    const played: HTMLMediaElement[] = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      played.push(this);
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const p = await eng.prepare(line('1'), 'fr');
    const h = eng.play(p, 1.2, 0.5);
    expect(played[0].playbackRate).toBeCloseTo(1.2);
    expect(played[0].volume).toBeCloseTo(0.5);
    h.setRate!(1.3);
    expect(played[0].playbackRate).toBeCloseTo(1.3);
    played[0].dispatchEvent(new Event('ended'));
    played[0].onended?.(new Event('ended'));
    expect(await h.done).toBe('ended');

    const h2 = eng.play(p, 1, 1);
    eng.stopAll();
    expect(await h2.done).toBe('stopped');
    eng.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(p.url);
  });

  it('play without url resolves error', async () => {
    const h = new AudioEngine('openai').play({ line: line('1'), lang: 'fr', engine: 'openai' }, 1, 1);
    expect(await h.done).toBe('error');
  });
});

describe('splitText', () => {
  it('keeps short text whole and splits long text ≤ 180 at punctuation', () => {
    expect(splitText('  Hello   world. ')).toEqual(['Hello world.']);
    const long = 'Ceci est une phrase assez longue pour tester. '.repeat(8).trim();
    const parts = splitText(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(180);
    expect(parts.join(' ')).toBe(long);
    expect(parts[0].endsWith('.')).toBe(true);
  });
  it('hard-cuts text without spaces', () => {
    const parts = splitText('a'.repeat(400));
    expect(parts.map((p) => p.length)).toEqual([180, 180, 40]);
  });
});

describe('WebSpeechEngine', () => {
  let spoken: any[];
  let autoEnd: boolean;
  beforeEach(() => {
    spoken = [];
    autoEnd = true;
    const voice = { name: 'Thomas', lang: 'fr-FR', voiceURI: 'Thomas', localService: true, default: false };
    (globalThis as any).SpeechSynthesisUtterance = class {
      text: string; lang = ''; voice: unknown = null; rate = 1; volume = 1;
      onend: (() => void) | null = null; onerror: ((e: any) => void) | null = null;
      constructor(t: string) { this.text = t; }
    };
    (globalThis as any).speechSynthesis = {
      getVoices: () => [voice], addEventListener() {}, removeEventListener() {},
      speaking: false, pending: false,
      speak: vi.fn((u: any) => { spoken.push(u); if (autoEnd) setTimeout(() => u.onend?.(), 1); }),
      cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).speechSynthesis;
    delete (globalThis as any).SpeechSynthesisUtterance;
  });

  it('speaks each chunk with the voice re-applied, rate and volume', async () => {
    const eng = new WebSpeechEngine();
    const text = 'Une phrase de test assez longue pour être coupée en deux morceaux distincts. '.repeat(4).trim();
    const p = await eng.prepare(line('1', text), 'fr', 'Thomas');
    const h = eng.play(p, 1.2, 0.7);
    expect(await h.done).toBe('ended');
    expect(spoken.length).toBeGreaterThan(1);
    for (const u of spoken) {
      expect(u.voice?.name).toBe('Thomas');
      expect(u.rate).toBeCloseTo(1.2);
      expect(u.volume).toBeCloseTo(0.7);
      expect(u.text.length).toBeLessThanOrEqual(180);
    }
  });

  it('watchdog cancels a stuck utterance and finishes', async () => {
    vi.useFakeTimers();
    autoEnd = false;
    const eng = new WebSpeechEngine();
    const h = eng.play({ line: line('1', 'Salut.'), lang: 'fr', engine: 'webspeech' }, 1, 1);
    let res: string | undefined;
    void h.done.then((r) => (res = r));
    await vi.advanceTimersByTimeAsync(watchdogMs('Salut.', 'fr', 1) - 10);
    expect(res).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(res).toBe('ended');
    expect((speechSynthesis as any).cancel).toHaveBeenCalled();
  });

  it('stop / stopAll resolve stopped; pause/resume call the synth', async () => {
    autoEnd = false;
    const eng = new WebSpeechEngine();
    const h = eng.play({ line: line('1', 'Salut.'), lang: 'fr', engine: 'webspeech' }, 1, 1);
    h.pause();
    expect((speechSynthesis as any).pause).toHaveBeenCalled();
    h.resume();
    expect((speechSynthesis as any).resume).toHaveBeenCalled();
    eng.stopAll();
    expect(await h.done).toBe('stopped');
  });

  it('watchdog formula is est*2.5+3000 (generous, never cuts slow voices)', () => {
    expect(watchdogMs('a'.repeat(14), 'en', 1)).toBeCloseTo(1000 * 2.5 + 3000);
  });
});
