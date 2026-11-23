// S (v1.1): session pacing + speaker wiring (late chained lines kept, voice calibration persisted, stable voice switch).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DubSession } from '../../src/content/session';
import type { DubSessionDeps } from '../../src/content/session';
import type { PlayEnd, PlayHandle, Prepared, TtsEngine } from '../../src/content/voice/engine';
import type { SpeechMeasure } from '../../src/content/voice/webspeech';
import { SpeakerPitch } from '../../src/content/sync/pitch';
import type { EngineId, Gender, Line, VoiceInfo } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { VoiceCalibration } from '../../src/content/sync/fit';
import { installChromeMock } from './helpers/chrome-mock';

class FakeVideo extends EventTarget { currentTime = 0; paused = false; seeking = false; playbackRate = 1; volume = 0.8; }
class FakeEngine implements TtsEngine {
  played: { p: Prepared; rate: number; end: (r: PlayEnd) => void }[] = [];
  onMeasure?: (m: SpeechMeasure) => void;
  constructor(public id: EngineId) {}
  async prepare(line: Line, lang: 'fr', voice?: string): Promise<Prepared> { return { line, lang, engine: this.id, voice }; }
  play(p: Prepared, rate: number): PlayHandle {
    let end!: (r: PlayEnd) => void;
    const done = new Promise<PlayEnd>((r) => { end = r; });
    this.played.push({ p, rate, end });
    return { done, stop: () => end('stopped'), pause() {}, resume() {} };
  }
  stopAll = vi.fn();
}
const voices: VoiceInfo[] = [
  { id: 'Thomas', name: 'Thomas', lang: 'fr-FR', engine: 'webspeech', gender: 'male', quality: 2 },
  { id: 'Amelie', name: 'Amélie', lang: 'fr-FR', engine: 'webspeech', gender: 'female', quality: 3 },
];

function setup(lines: Line[], over: Partial<DubSessionDeps> = {}) {
  const video = new FakeVideo();
  const engines: FakeEngine[] = [];
  const saved: VoiceCalibration[] = [];
  let pitch: SpeakerPitch | null = null;
  const deps: Partial<DubSessionDeps> = {
    getLines: async () => lines,
    createEngine: (id) => { const e = new FakeEngine(id); engines.push(e); return e; },
    listVoices: async () => voices,
    pickBestVoice: async () => voices[1],
    pickVoiceFor: async (_l, g: Gender) => (g === 'male' ? voices[0] : voices[1]),
    resetVoiceChoices: vi.fn(),
    warmUpTranslator: vi.fn(),
    createPitch: (v) => (pitch = new SpeakerPitch(v)),
    now: () => 0,
    saveStat: vi.fn(),
    loadVoiceCal: async () => ({ 'webspeech:fr:Amelie': { f: 0.8, n: 10 } }),
    saveVoiceCal: (c) => { saved.push(c); },
    ...over,
  };
  const s = new DubSession({ videoId: 'v', settings: { ...DEFAULT_SETTINGS, preferNeural: false }, video: video as unknown as HTMLVideoElement, player: document.createElement('div'), deps });
  return { s, video, engines, saved, pitch: () => pitch! };
}
async function play(video: FakeVideo, to: number) {
  while (video.currentTime < to) { video.currentTime = Math.round((video.currentTime + 0.05) * 1000) / 1000; await vi.advanceTimersByTimeAsync(50); }
}
beforeEach(() => { installChromeMock(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('DubSession v1.1 pacing', () => {
  it('a line chained > 0.3 s late is still spoken (v1.0 dropped it → silence holes)', async () => {
    const lines: Line[] = [
      { id: 'a', start: 1, end: 3, text: 'Première phrase assez longue.' },
      { id: 'b', start: 3.1, end: 5, text: 'Deuxième.' },
    ];
    const { s, video, engines } = setup(lines);
    await s.start();
    await play(video, 1.0);
    const e = engines[0];
    expect(e.played.map((x) => x.p.line.id)).toEqual(['a']);
    await play(video, 4.2); // 'a' runs 1.1 s into 'b'
    e.played[0].end('ended');
    await play(video, 4.3);
    expect(e.played.map((x) => x.p.line.id)).toEqual(['a', 'b']);
    expect(e.played[1].rate).toBeLessThanOrEqual(1.35);
    s.stop();
  });

  it('loads per-voice calibration, slower voice gets a higher rate, measurements are persisted', async () => {
    const lines: Line[] = [
      { id: 'a', start: 1, end: 6, text: 'Bonjour à tous, voici une phrase.' },
      { id: 'b', start: 8, end: 13, text: '[Homme] Et voici la réponse, merci.', gender: 'male' },
    ];
    const { s, video, engines, saved } = setup(lines);
    await s.start();
    await play(video, 1.0);
    const e = engines[0];
    // Amelie stored 20 % slower than the prior, Thomas unknown (1): pace = their mean (0.9) → same perceived speed.
    expect(e.played[0].rate).toBeCloseTo(0.9 / 0.8, 2);
    e.played[0].end('ended');
    await play(video, 8.0);
    expect(e.played[1].p.voice).toBe('Thomas');
    expect(e.played[1].rate).toBeCloseTo(0.9, 2);
    expect(typeof e.onMeasure).toBe('function');
    e.onMeasure!({ voice: 'Amelie', lang: 'fr', text: 'Bonjour à tous, voici une phrase.', rate: 1, speechMs: 2600 });
    s.stop();
    expect(saved.length).toBe(1);
    const json = saved[0].toJSON();
    expect(json['webspeech:fr:Amelie'].n).toBe(11);
  });

  it('voice switches on a caption speaker marker + evidence, not on one noisy line', async () => {
    const lines: Line[] = [];
    for (let i = 0; i < 8; i++) lines.push({ id: `l${i}`, start: 1 + i * 3, end: 3 + i * 3, text: 'Salut.', newSpeaker: i === 5 });
    const { s, video, engines, pitch } = setup(lines);
    await s.start();
    const p = pitch();
    const f0 = (i: number) => (i === 2 ? 240 : i >= 5 ? 230 : 120); // line 2 = one noisy high line; line 5 = real change
    for (let i = 0; i < 8; i++) for (let t = lines[i].start; t < lines[i].end; t += 0.05) p.addFrame(t, f0(i), 0.05);
    const e = engines[0];
    for (let i = 0; i < 8; i++) {
      await play(video, lines[i].start);
      e.played.at(-1)?.end('ended');
    }
    await play(video, 23.2);
    const v = e.played.map((x) => x.p.voice);
    expect(v[0]).toBe('Amelie'); // nothing heard yet → best voice
    expect(v.slice(1, 6)).toEqual(['Thomas', 'Thomas', 'Thomas', 'Thomas', 'Thomas']); // l2's noise did not flip l3
    expect(v[6]).toBe('Amelie'); // marker on l5 + evidence → l6 female (within 1 line)
    s.stop();
  });
});

describe('v1.1.1 default French engine', () => {
  it('French + preferNeural uses the neural engine even when engine is webspeech', async () => {
    const { s, engines } = setup([{ id: 'a', start: 1, end: 3, text: 'Bonjour' }]);
    (s as unknown as { settings: typeof DEFAULT_SETTINGS }).settings = { ...DEFAULT_SETTINGS, targetLang: 'fr', engine: 'webspeech', preferNeural: true };
    await s.start();
    expect(engines[0].id).toBe('neural');
    s.stop();
  });
});
