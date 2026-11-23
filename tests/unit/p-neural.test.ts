// P (v1.1): neural voice catalog, Piper helpers, NeuralEngine fallback logic, Web Speech French ranking.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import { NEURAL_VOICES, defaultNeuralVoice, modelPath, modelUrls, neuralVoice, recommendedModels } from '../../src/content/voice/neural-catalog';
import { cleanText, encodeWav, normalizePeak, trimSilence, bytesToB64 } from '../../src/offscreen/piper';
import { NeuralEngine, MAX_ERRORS } from '../../src/content/voice/neural';
import { createEngine } from '../../src/content/voice/engine';
import { hasHighQualityVoice, listVoices, neuralVoiceInfos, rankWebVoices, voiceTier } from '../../src/content/voice/voices';
import { normalizeSettings } from '../../src/shared/settings';
import type { Line } from '../../src/shared/types';
import type { TtsEngine, Prepared } from '../../src/content/voice/engine';

const line = (id: string, text = 'Salut tout le monde !'): Line => ({ id, start: 0, end: 2, text });

describe('neural catalog', () => {
  it('builds rhasspy/piper-voices paths', () => {
    expect(modelPath('fr_FR-siwis-medium')).toBe('fr/fr_FR/siwis/medium/fr_FR-siwis-medium');
    expect(modelUrls('fr_FR-upmc-medium').onnx).toBe('https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx');
    expect(() => modelPath('bad')).toThrow();
  });
  it('has a male + female recommended French pair', () => {
    expect(recommendedModels('fr')).toEqual(['fr_FR-siwis-medium', 'fr_FR-tom-medium']);
    expect(defaultNeuralVoice('fr', 'female')?.name).toBe('Siwis');
    expect(defaultNeuralVoice('fr', 'male')?.name).toBe('Tom');
    expect(neuralVoice('fr_FR-upmc-medium#pierre')?.speaker).toBe('pierre');
    for (const v of NEURAL_VOICES) expect(() => modelPath(v.model)).not.toThrow();
  });
  it('lists neural VoiceInfo with downloaded voices first', () => {
    const list = neuralVoiceInfos('fr', ['fr_FR-upmc-medium']);
    expect(list[0].name).toBe('Jessica');
    expect(list.every((v) => v.engine === 'neural')).toBe(true);
    expect(neuralVoiceInfos('fr').map((v) => v.gender)).toContain('male');
  });
});

describe('piper helpers', () => {
  it('encodes a 16-bit mono WAV header', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 22050);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(22050);
    expect(v.getUint32(40, true)).toBe(8);
    expect(v.getInt16(46, true)).toBe(16383);
    expect(bytesToB64(wav)).toMatch(/^UklGR/);
  });
  it('trims silence and normalises the peak', () => {
    const pcm = new Float32Array(22050);
    pcm.fill(0.2, 5000, 6000);
    const t = trimSilence(pcm, 22050, 0.015, 0);
    expect(t.length).toBe(1000);
    expect(Math.max(...normalizePeak(Float32Array.from(t)))).toBeCloseTo(0.9, 5);
  });
  it('drops caption noise', () => {
    expect(cleanText('[Musique]  Salut ♪ (rires) les amis')).toBe('Salut les amis');
  });
});

describe('Web Speech French ranking', () => {
  const V = (name: string, lang: string) => ({ name, lang, voiceURI: name, default: false, localService: true }) as SpeechSynthesisVoice;
  it('Premium > Enhanced > Google > compact; fr-FR before fr-CA in a tier', () => {
    const ranked = rankWebVoices([V('Thomas', 'fr-FR'), V('Google français', 'fr-FR'), V('Amélie (Enhanced)', 'fr-CA'),
      V('Thomas (Enhanced)', 'fr-FR'), V('Audrey (Premium)', 'fr-FR'), V('Amélie', 'fr-CA')], 'fr').map((v) => v.name);
    expect(ranked).toEqual(['Audrey (Premium)', 'Thomas (Enhanced)', 'Amélie (Enhanced)', 'Google français', 'Thomas', 'Amélie']);
    expect(voiceTier('Eddy (French (France))')).toBeLessThan(0);
  });
  it('flags when only compact/Google voices are installed', () => {
    expect(hasHighQualityVoice([{ name: 'Thomas' }, { name: 'Google français' }])).toBe(false);
    expect(hasHighQualityVoice([{ name: 'Thomas (Enhanced)' }])).toBe(true);
  });
});

describe('settings', () => {
  it('accepts engine neural and preferNeural', () => {
    expect(normalizeSettings({ engine: 'neural' }).engine).toBe('neural');
    expect(normalizeSettings({}).preferNeural).toBe(true);
    expect(normalizeSettings({ preferNeural: false }).preferNeural).toBe(false);
  });
});

class FakeWeb implements TtsEngine {
  id = 'webspeech' as const;
  prepared: (string | undefined)[] = [];
  async prepare(l: Line, lang: 'fr', voice?: string): Promise<Prepared> { this.prepared.push(voice); return { line: l, lang, engine: 'webspeech', voice }; }
  play() { return { done: Promise.resolve('ended' as const), stop() {}, pause() {}, resume() {} }; }
  stopAll() {}
}

describe('NeuralEngine', () => {
  beforeEach(() => {
    installChromeMock();
    let n = 0;
    (URL as any).createObjectURL = vi.fn(() => `blob:n/${n++}`);
    (URL as any).revokeObjectURL = vi.fn();
  });

  it('createEngine("neural") returns a NeuralEngine', () => {
    expect(createEngine('neural')).toBeInstanceOf(NeuralEngine);
  });

  it('ready model → WAV Blob URL with exact knownMs', async () => {
    const send = vi.fn(async () => ({ ok: true as const, audioB64: btoa('RIFF'), mime: 'audio/wav', ms: 1234 }));
    const eng = new NeuralEngine({ send, web: new FakeWeb(), webVoiceFor: async () => 'w' });
    const p = await eng.prepare(line('1'), 'fr', 'fr_FR-tom-medium');
    expect(send.mock.calls[0]).toEqual([{ type: 'NEURAL_TTS', text: 'Salut tout le monde !', lang: 'fr', voice: 'fr_FR-tom-medium' }]);
    expect(p).toMatchObject({ engine: 'neural', knownMs: 1234, voice: 'fr_FR-tom-medium' });
    expect(await eng.prepare(line('1'), 'fr', 'fr_FR-tom-medium')).toBe(p);
  });

  it('model downloading → Web Speech of the same gender (no silence), then backs off', async () => {
    const web = new FakeWeb();
    const send = vi.fn(async () => ({ ok: true as const, pending: true, progress: 0.3 }));
    const webVoiceFor = vi.fn(async (_l: string, g: string) => `web-${g}`);
    const eng = new NeuralEngine({ send, web, webVoiceFor });
    const p = await eng.prepare(line('1'), 'fr', 'fr_FR-tom-medium');
    expect(p.engine).toBe('webspeech');
    expect(web.prepared).toEqual(['web-male']);
    expect(eng.downloadProgress).toBe(0.3);
    await eng.prepare(line('2'), 'fr', 'fr_FR-tom-medium');
    expect(send).toHaveBeenCalledTimes(1); // backoff: no second request within 3 s
  });

  it('unknown/other-language voice → default voice for the language', async () => {
    const send = vi.fn(async () => ({ ok: true as const, audioB64: btoa('x'), mime: 'audio/wav', ms: 10 }));
    const eng = new NeuralEngine({ send, web: new FakeWeb() });
    await eng.prepare(line('1'), 'fr', 'Thomas');
    expect((send.mock.calls[0] as any)[0].voice).toBe('fr_FR-siwis-medium');
  });

  it(`after ${MAX_ERRORS} errors asks the session to fall back once`, async () => {
    const onFallback = vi.fn();
    const send = vi.fn(async () => ({ ok: false as const, error: 'ENGINE_ERROR' as const, message: 'boom' }));
    const eng = new NeuralEngine({ send, web: new FakeWeb(), webVoiceFor: async () => undefined, onFallback });
    for (let i = 0; i < MAX_ERRORS + 2; i++) expect((await eng.prepare(line(String(i)), 'fr')).engine).toBe('webspeech');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(MAX_ERRORS);
  });

  it('listVoices(lang, "neural") reads downloaded models from storage', async () => {
    installChromeMock({ neuralReady: ['fr_FR-tom-medium'] });
    const list = await listVoices('fr', 'neural');
    expect(list[0].id).toBe('fr_FR-tom-medium');
  });
});
