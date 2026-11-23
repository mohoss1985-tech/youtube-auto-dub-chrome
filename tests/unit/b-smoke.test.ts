// Wave 0 smoke for owner B: modules import; SW router dispatches TTS / cache.
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import * as engine from '../../src/content/voice/engine';
import { WebSpeechEngine } from '../../src/content/voice/webspeech';
import { AudioEngine } from '../../src/content/voice/audio';
import * as voices from '../../src/content/voice/voices';
import * as tts from '../../src/background/tts';
import * as cache from '../../src/background/cache';

describe('B smoke', () => {
  beforeEach(() => void installChromeMock());

  it('exports the §8 names', () => {
    expect(engine.createEngine).toBeTypeOf('function');
    expect(new WebSpeechEngine().id).toBe('webspeech');
    expect(new AudioEngine('openai').id).toBe('openai');
    for (const f of [voices.listVoices, voices.pickBestVoice, voices.pickVoiceFor]) expect(f).toBeTypeOf('function');
    expect(tts.synthesize).toBeTypeOf('function');
    for (const f of [cache.cacheGet, cache.cachePut, cache.cacheEvict]) expect(f).toBeTypeOf('function');
  });

  it('SW router: TTS without implementation returns an error, never throws', async () => {
    const { handleMessage } = await import('../../src/background/index');
    const res = await handleMessage({ type: 'TTS', text: 'Bonjour', lang: 'fr', engine: 'openai', voice: 'alloy' });
    expect(res.ok).toBe(false);
  });

  it('SW router: CACHE_PUT/GET reach the cache module', async () => {
    const { handleMessage } = await import('../../src/background/index');
    expect(await handleMessage({ type: 'CACHE_PUT', store: 'lines', key: 'lines:x:fr', value: [] })).toEqual({ ok: true });
    expect((await handleMessage({ type: 'CACHE_GET', store: 'lines', key: 'lines:x:fr' })).ok).toBe(true);
  });
});
