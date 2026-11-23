import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DubSession } from '../../src/content/session';
import type { DubSessionDeps } from '../../src/content/session';
import type { PlayEnd, PlayHandle, Prepared, TtsEngine } from '../../src/content/voice/engine';
import type { DubStatus, EngineId, Gender, Line, VoiceInfo } from '../../src/shared/types';
import { DubError } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { installChromeMock } from './helpers/chrome-mock';

class FakeVideo extends EventTarget {
  currentTime = 0; paused = false; seeking = false; playbackRate = 1; volume = 0.8;
}

class FakeEngine implements TtsEngine {
  played: { p: Prepared; rate: number; handle: PlayHandle; end: (r: PlayEnd) => void }[] = [];
  prepared: { line: Line; voice?: string }[] = [];
  failPlay = false;
  constructor(public id: EngineId) {}
  async prepare(line: Line, lang: 'fr', voice?: string): Promise<Prepared> {
    this.prepared.push({ line, voice });
    return { line, lang, engine: this.id, voice, knownMs: this.id === 'webspeech' ? undefined : 1000 };
  }
  play(p: Prepared, rate: number): PlayHandle {
    let end!: (r: PlayEnd) => void;
    const done = new Promise<PlayEnd>((r) => { end = r; });
    const handle = { done, stop: () => end('stopped'), pause() {}, resume() {} };
    this.played.push({ p, rate, handle, end });
    if (this.failPlay) end('error');
    return handle;
  }
  stopAll = vi.fn();
  dispose = vi.fn();
}

const voices: VoiceInfo[] = [
  { id: 'Thomas', name: 'Thomas', lang: 'fr-FR', engine: 'webspeech', gender: 'male', quality: 2 },
  { id: 'Amelie', name: 'Amélie', lang: 'fr-FR', engine: 'webspeech', gender: 'female', quality: 3 },
];

const LINES: Line[] = [
  { id: 'a', start: 1, end: 3, text: 'Bonjour à tous.' },
  { id: 'b', start: 4, end: 6, text: '[Homme] Salut.', gender: 'male' },
  { id: 'c', start: 10, end: 12, text: 'Au revoir.' },
];

function setup(over: Partial<DubSessionDeps> = {}, settings = {}) {
  const video = new FakeVideo();
  const player = document.createElement('div');
  const engines: FakeEngine[] = [];
  const toasts: string[] = [];
  const statuses: DubStatus[] = [];
  const stat = vi.fn();
  let clock = 0;
  const deps: Partial<DubSessionDeps> = {
    getLines: async () => LINES,
    createEngine: (id) => { const e = new FakeEngine(id); engines.push(e); return e; },
    listVoices: async () => voices,
    pickBestVoice: async () => voices[1],
    pickVoiceFor: async (_l, g: Gender) => (g === 'male' ? voices[0] : voices[1]),
    resetVoiceChoices: vi.fn(),
    warmUpTranslator: vi.fn(),
    now: () => clock,
    saveStat: stat,
    ...over,
  };
  const s = new DubSession({
    videoId: 'vid1', settings: { ...DEFAULT_SETTINGS, ...settings },
    video: video as unknown as HTMLVideoElement, player, deps,
    onToast: (m) => toasts.push(m),
  });
  s.onStatus((st) => statuses.push(st));
  return { s, video, player, engines, toasts, statuses, stat, setClock: (v: number) => { clock = v; } };
}

async function play(video: FakeVideo, to: number) {
  while (video.currentTime < to) {
    video.currentTime = Math.round((video.currentTime + 0.05) * 1000) / 1000;
    await vi.advanceTimersByTimeAsync(50);
  }
}

beforeEach(() => { installChromeMock(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('DubSession', () => {
  it('preparing → dubbing, speaks lines on time, measures firstLineMs, picks gendered voices', async () => {
    const { s, video, engines, statuses, stat, setClock } = setup();
    const started = s.start();
    expect(s.getStatus().state).toBe('preparing');
    await started;
    expect(s.getStatus().state).toBe('dubbing');
    expect(statuses.map((x) => x.state)).toEqual(['preparing', 'dubbing']);
    setClock(900);
    await play(video, 1.0);
    const e = engines[0];
    expect(e.played.length).toBe(1);
    expect(e.played[0].p.line.id).toBe('a');
    expect(e.played[0].p.voice).toBe('Amelie'); // first line: unknown → best voice
    expect(s.currentLine()?.id).toBe('a');
    expect(s.getStatus().firstLineMs).toBe(900);
    expect(stat).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'vid1', ms: 900 }));
    e.played[0].end('ended');
    await play(video, 4.0);
    expect(e.played[1].p.line.id).toBe('b');
    expect(e.played[1].p.voice).toBe('Thomas'); // caption label male
    s.stop();
  });

  it('ad: pauses dub, restores volume, status paused-ad, resyncs after', async () => {
    const { s, video, player, engines } = setup();
    await s.start();
    await play(video, 1.0);
    await vi.advanceTimersByTimeAsync(200); // duck ramp
    expect(video.volume).toBeLessThan(0.8);
    player.classList.add('ad-showing');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getStatus().state).toBe('paused-ad');
    expect(video.volume).toBeCloseTo(0.8, 5);
    expect(s.currentLine()).toBeNull();
    // Ad time runs: nothing is spoken even when its currentTime passes line starts.
    video.currentTime = 4.5;
    await vi.advanceTimersByTimeAsync(500);
    const n = engines[0].played.length;
    expect(n).toBe(1);
    player.classList.remove('ad-showing');
    video.currentTime = 9.5;
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getStatus().state).toBe('dubbing');
    await play(video, 10.0);
    expect(engines[0].played.at(-1)!.p.line.id).toBe('c');
    s.stop();
  });

  it('holdDuck: original stays low between lines while dubbing', async () => {
    const { s, video, engines } = setup();
    await s.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(video.volume).toBeLessThan(0.2); // ducked as soon as dubbing starts
    await play(video, 1.0);
    engines[0].played[0]?.end('ended');
    await play(video, 3.0); // gap between lines
    await vi.advanceTimersByTimeAsync(500);
    expect(video.volume).toBeLessThan(0.2);
    s.stop();
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it('stop restores ducked volume and is idempotent', async () => {
    const { s, video, engines } = setup();
    await s.start();
    await play(video, 1.1);
    await vi.advanceTimersByTimeAsync(200);
    expect(video.volume).toBeLessThan(0.2);
    s.stop();
    expect(video.volume).toBeCloseTo(0.8, 5);
    expect(engines[0].dispose).toHaveBeenCalled();
    s.stop();
    expect(s.getStatus().state).toBe('idle');
  });

  it('seek during dubbing restarts from the new position', async () => {
    const { s, video, engines } = setup();
    await s.start();
    await play(video, 1.0);
    video.currentTime = 9.95;
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked'));
    await play(video, 10.0);
    expect(engines[0].played.map((p) => p.p.line.id)).toEqual(['a', 'c']);
    s.stop();
  });

  it('API engine error → toast + fallback to Web Speech', async () => {
    const { s, video, engines, toasts } = setup({}, { engine: 'openai' });
    await s.start();
    engines[0].failPlay = true;
    await play(video, 1.0);
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts.join(' ')).toMatch(/free browser voice/);
    expect(engines.at(-1)!.id).toBe('webspeech');
    await play(video, 4.0);
    expect(engines.at(-1)!.played.at(-1)!.p.line.id).toBe('b');
    s.stop();
  });

  it('pipeline errors become error status with the code', async () => {
    const { s } = setup({ getLines: async () => { throw new DubError('NO_TRANSLATION', 'no way'); } });
    await s.start();
    expect(s.getStatus()).toMatchObject({ state: 'error', error: 'NO_TRANSLATION' });
    const r = await s.toggle(false);
    expect(r.state).toBe('idle');
  });

  it('no voice for Web Speech → NO_VOICE', async () => {
    const { s } = setup({ listVoices: async () => [], pickBestVoice: async () => null });
    await s.start();
    expect(s.getStatus()).toMatchObject({ state: 'error', error: 'NO_VOICE' });
  });

  it('warms the translator synchronously in start() and streams progressive lines into the scheduler', async () => {
    let onUpdate: ((l: Line[]) => void) | undefined;
    let opts: unknown;
    const warm = vi.fn((_to: string, prog?: (p: number) => void) => prog?.(40));
    const { s, video, engines } = setup({
      warmUpTranslator: warm,
      getLines: async (_v, _l, _p, o) => { opts = o; onUpdate = o?.onUpdate; return LINES.slice(0, 1); },
    });
    const p = s.start();
    expect(warm).toHaveBeenCalledWith('fr', expect.any(Function)); // before any await
    expect(s.getStatus().message).toBe('Downloading French translator… 40%');
    await p;
    expect(opts).toMatchObject({ fromTime: 0 });
    await play(video, 1.0);
    onUpdate!(LINES); // rest of the translation arrives
    engines[0].played[0]?.end('ended'); // continuous mode: 'b' waits for 'a' to finish
    await play(video, 4.0);
    expect(engines[0].played.map((x) => x.p.line.id)).toEqual(['a', 'b']); // 'a' not replayed
    s.stop();
  });
});
