// E (v1.2): expressive rendering wiring — parameter mapping, expressiveness 0 = exact v1.1 path, Web Speech pitch,
// scene arousal from the original audio, planner speed hint, settings and the popup "Expression" slider.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prosodyFor, speedHint, webSpeechProsody, emphasisSpans } from '../../src/shared/prosody';
import { analyzeEmotion } from '../../src/content/text/emotion';
import { NeuralEngine } from '../../src/content/voice/neural';
import { WebSpeechEngine } from '../../src/content/voice/webspeech';
import type { TtsEngine } from '../../src/content/voice/engine';
import { sceneEnergy, SceneArousal, type PitchFrame } from '../../src/content/sync/pitch';
import { planTrack } from '../../src/content/sync/fit';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/shared/settings';
import { encodeWav } from '../../src/offscreen/piper';
import { expressify } from '../../src/offscreen/prosody-dsp';
import { installChromeMock } from './helpers/chrome-mock';
import { initPopup, mockBackend, exprLabel, TEST_LINES } from '../../src/popup/popup';
import type { Line, LineEmotion } from '../../src/shared/types';

const E = (style: LineEmotion['style'], intensity = 0.7, emphasisWords: string[] = []): LineEmotion => ({ style, intensity, emphasisWords });

describe('prosodyFor', () => {
  it('expressiveness 0 → undefined (v1.1 sound); speed hint 1; no Web Speech change', () => {
    expect(prosodyFor(E('excited'), 'Waouh !', 0.9, 0)).toBeUndefined();
    expect(speedHint(E('excited'), 0.9, 0)).toBe(1);
    expect(webSpeechProsody(E('shout'), 0.9, 0)).toBeNull();
  });

  it('stays inside the allowed ranges for every style and extreme inputs', () => {
    for (const s of ['neutral', 'excited', 'happy', 'question', 'surprised', 'sad', 'calm', 'shout'] as const) {
      for (const [a, x, i] of [[0, 1, 1], [1, 1, 1], [0.5, 0.7, 0.5], [1, 0.05, 0]]) {
        const p = prosodyFor(E(s, i, ['dix']), 'Il a gagné dix mille dollars', a, x)!;
        expect(p.noiseScale).toBeGreaterThanOrEqual(0.55); expect(p.noiseScale).toBeLessThanOrEqual(0.9);
        expect(p.noiseW).toBeGreaterThanOrEqual(0.6); expect(p.noiseW).toBeLessThanOrEqual(1.1);
        expect(p.pitchK).toBeGreaterThanOrEqual(1); expect(p.pitchK).toBeLessThanOrEqual(1.8);
        expect(p.meanShiftSt).toBeLessThanOrEqual(3);
        expect(p.gainDb).toBeLessThanOrEqual(4);
        for (const e of p.emphasis) { expect(e.db).toBeLessThanOrEqual(6); expect(e.from).toBeLessThan(e.to); }
        const w = webSpeechProsody(E(s, i), a, x)!;
        expect(w.pitch).toBeGreaterThanOrEqual(0.9); expect(w.pitch).toBeLessThanOrEqual(1.35);
        const h = speedHint(E(s, i), a, x);
        expect(h).toBeGreaterThanOrEqual(0.95); expect(h).toBeLessThanOrEqual(1.06);
      }
    }
  });

  it('excited/question/surprised expand more than neutral; question rises, statements fall', () => {
    const n = prosodyFor(E('neutral'), 'On y va.', 0.5, 0.7)!;
    const x = prosodyFor(E('excited'), 'On y va !', 0.5, 0.7)!;
    const q = prosodyFor(E('question'), 'On y va ?', 0.5, 0.7)!;
    expect(x.pitchK).toBeGreaterThan(n.pitchK);
    expect(x.meanShiftSt).toBeGreaterThan(1);
    expect(q.endShiftSt).toBeGreaterThan(2);
    expect(n.endShiftSt).toBeLessThan(0);
    expect(x.gainDb).toBeGreaterThan(n.gainDb);
  });

  it('higher scene arousal → livelier; emphasis spans found in the text', () => {
    const lo = prosodyFor(E('neutral'), 'Salut', 0.1, 0.7)!;
    const hi = prosodyFor(E('neutral'), 'Salut', 0.95, 0.7)!;
    expect(hi.meanShiftSt).toBeGreaterThan(lo.meanShiftSt);
    expect(hi.pitchK).toBeGreaterThan(lo.pitchK);
    expect(emphasisSpans('Il a gagné dix mille dollars', ['dix', 'absent'])).toEqual([{ from: 0.393, to: 0.5 }]);
  });
});

describe('expressiveness 0 = byte-identical v1.1 path', () => {
  const line: Line = { id: 'a', start: 0, end: 2, text: 'Incroyable ! Il a gagné dix mille dollars !' };
  const send = vi.fn(async (_m: Record<string, unknown>) => ({ ok: true as const, audioB64: 'UklGRg==', mime: 'audio/wav', ms: 1000 }));
  beforeEach(() => {
    send.mockClear();
    (URL as any).createObjectURL ??= () => 'blob:x';
  });

  it('NEURAL_TTS request is exactly the v1.1 shape at 0, carries prosody at 0.7', async () => {
    const web = { prepare: vi.fn(), play: vi.fn(), stopAll: vi.fn(), id: 'webspeech' } as unknown as TtsEngine;
    const e0 = new NeuralEngine({ send: send as never, web });
    e0.setExpression(() => ({ expressiveness: 0, arousal: 0.9 }));
    await e0.prepare(line, 'fr', 'fr_FR-siwis-medium');
    expect(send.mock.calls[0][0]).toEqual({ type: 'NEURAL_TTS', text: line.text, lang: 'fr', voice: 'fr_FR-siwis-medium' });
    const e1 = new NeuralEngine({ send: send as never, web });
    await e1.prepare(line, 'fr', 'fr_FR-siwis-medium'); // no expression source → v1.1 too
    expect(Object.keys(send.mock.calls[1][0])).toEqual(['type', 'text', 'lang', 'voice']);
    const e2 = new NeuralEngine({ send: send as never, web });
    e2.setExpression(() => ({ expressiveness: 0.7, arousal: 0.6 }));
    await e2.prepare(line, 'fr', 'fr_FR-siwis-medium');
    const p = send.mock.calls[2][0].prosody as { pitchK: number } | undefined;
    expect(p?.pitchK).toBeGreaterThan(1.2);
  });

  it('a no-op ProsodyParams leaves the PCM samples unchanged (WAV bytes identical)', () => {
    const sr = 22050;
    const x = new Float32Array(sr).map((_, i) => 0.4 * Math.sin((2 * Math.PI * 180 * i) / sr));
    const y = expressify(x, sr, { noiseScale: 0.667, noiseW: 0.8, pitchK: 1, meanShiftSt: 0, endShiftSt: 0, endMs: 300, gainDb: 0, emphasis: [] }).pcm;
    expect(encodeWav(y, sr)).toEqual(encodeWav(x, sr));
  });
});

describe('Web Speech expressive pitch/volume', () => {
  let utts: any[];
  beforeEach(() => {
    vi.useFakeTimers();
    utts = [];
    (globalThis as any).speechSynthesis = { speaking: false, pending: false, speak: (u: any) => utts.push(u), cancel() {}, pause() {}, resume() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {} };
    (globalThis as any).SpeechSynthesisUtterance = class { text: string; lang = ''; voice: unknown = null; rate = 1; volume = 1; pitch = 1; constructor(t: string) { this.text = t; } };
  });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as any).speechSynthesis; delete (globalThis as any).SpeechSynthesisUtterance; });

  it('excited line → higher pitch; expressiveness 0 → untouched utterance', () => {
    const eng = new WebSpeechEngine();
    const line: Line = { id: 'a', start: 0, end: 1, text: 'Waouh, dix mille dollars !', source: 'WOW, $10,000!' };
    eng.play({ line, lang: 'fr', engine: 'webspeech' }, 1, 1);
    expect(utts[0].pitch).toBe(1);
    eng.stopAll();
    eng.setExpression(() => ({ expressiveness: 0.7, arousal: 0.7 }));
    eng.play({ line, lang: 'fr', engine: 'webspeech' }, 1, 1);
    expect(utts[1].pitch).toBeGreaterThan(1.1);
    eng.stopAll();
    eng.setExpression(() => ({ expressiveness: 0, arousal: 0.7 }));
    eng.play({ line, lang: 'fr', engine: 'webspeech' }, 1, 0.8);
    expect(utts[2].pitch).toBe(1);
    expect(utts[2].volume).toBe(0.8);
  });
});

describe('scene arousal from the original audio', () => {
  /** 20 frames/s; `lively` = loud with wide F0 swings, else quiet monotone. */
  const frames = (from: number, to: number, lively: boolean, out: PitchFrame[] = []) => {
    for (let t = from; t < to; t += 0.05) {
      const f0 = lively ? 220 * 2 ** ((5 * Math.sin(t * 7)) / 12) : 120 * 2 ** ((0.8 * Math.sin(t * 3)) / 12);
      out.push({ t, f0, rms: lively ? 0.2 : 0.05 });
    }
    return out;
  };

  it('MrBeast-like energy → high, calm narration → low', () => {
    const fr = frames(0, 30, false);
    frames(30, 40, true, fr);
    const hi = sceneEnergy(fr, 40)!;
    const lo = sceneEnergy(fr, 30)!;
    expect(hi.loudDb).toBeGreaterThan(6);
    expect(hi.f0StdSt).toBeGreaterThan(3);
    expect(hi.arousal).toBeGreaterThan(0.75);
    expect(lo.arousal).toBeLessThan(0.45);
  });

  it('EMA smooths changes (lags on purpose)', () => {
    const fr = frames(0, 30, false);
    const a = new SceneArousal();
    for (let t = 1; t <= 30; t += 0.5) a.update(fr, t);
    const calm = a.value();
    frames(30, 32, true, fr);
    for (let t = 30.5; t <= 32; t += 0.5) a.update(fr, t);
    const after2s = a.value();
    expect(after2s).toBeGreaterThan(calm);
    expect(after2s - calm).toBeLessThan(sceneEnergy(fr, 32)!.arousal - calm);
  });
});

describe('planner speed hint', () => {
  it('hint 1 (or absent) = same plan; hint > 1 raises that line only, still capped', () => {
    const lines: Line[] = [{ id: 'a', start: 0, end: 2, text: 'x' }, { id: 'b', start: 2.1, end: 4, text: 'y' }];
    const base = planTrack(lines, () => ({ u: 1500, f: 1 }));
    const same = planTrack(lines, () => ({ u: 1500, f: 1, hint: 1 }));
    expect(same.map((p) => p.rate)).toEqual(base.map((p) => p.rate));
    const fast = planTrack(lines, (l) => ({ u: 1500, f: 1, hint: l.id === 'b' ? 1.05 : 1 }));
    expect(fast[0].rate).toBe(base[0].rate);
    expect(fast[1].rate).toBeCloseTo(base[1].rate * 1.05, 5);
  });
});

describe('settings + popup', () => {
  it('expressiveness defaults to 0.7 and is clamped', () => {
    expect(DEFAULT_SETTINGS.expressiveness).toBe(0.7);
    expect(normalizeSettings({}).expressiveness).toBe(0.7);
    expect(normalizeSettings({ expressiveness: 3 }).expressiveness).toBe(1);
    expect(normalizeSettings({ expressiveness: 0 }).expressiveness).toBe(0);
  });

  it('Expression slider under Voice speed (Flat ↔ Lively, 70 %), saves expressiveness', async () => {
    installChromeMock();
    document.body.innerHTML = '<main id="x"></main>';
    const root = document.getElementById('x')!;
    let saved: Record<string, unknown> = {};
    const base = mockBackend('idle');
    await initPopup(root, { backend: { ...base, saveSettings: async (p) => { saved = { ...saved, ...p }; return base.saveSettings(p); } } });
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5));
    const expr = root.querySelector<HTMLInputElement>('[data-el="expr"]')!;
    const speed = root.querySelector<HTMLInputElement>('[data-el="speed"]')!;
    expect(expr.value).toBe('70');
    expect(speed.compareDocumentPosition(expr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(root.querySelector('.slider-ends')?.textContent).toBe('FlatLively');
    expect(root.querySelector('[data-el="expr-val"]')?.textContent).toBe('Lively · 70%');
    expr.value = '0';
    expr.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    expect(saved.expressiveness).toBe(0);
    expect(exprLabel(0)).toBe('Flat · 0%');
  });

  it('▶ Test plays a lively French sample', () => {
    expect(TEST_LINES.fr).toBe('Incroyable ! Il a gagné dix mille dollars !');
    expect(analyzeEmotion({ text: TEST_LINES.fr }).style).toBe('excited');
  });
});
