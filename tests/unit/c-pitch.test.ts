import { describe, it, expect, vi } from 'vitest';
import { estimateF0, classifyFrames, captionGender, SpeakerPitch } from '../../src/content/sync/pitch';
import type { Line } from '../../src/shared/types';

const SR = 48000;
function sine(hz: number, n = 2048, amp = 0.5, sr = SR, harmonics = false): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * hz * i) / sr;
    b[i] = amp * (Math.sin(ph) + (harmonics ? 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph) : 0));
  }
  return b;
}
const line = (start: number, end: number, extra: Partial<Line> = {}): Line => ({ id: `${start}`, start, end, text: 'x', ...extra });
const fakeVideo = () => ({ paused: false, seeking: false, currentTime: 0 }) as unknown as HTMLVideoElement;

describe('estimateF0', () => {
  it('finds 120 Hz and 220 Hz sines (with harmonics too)', () => {
    expect(estimateF0(sine(120), SR)!).toBeCloseTo(120, -0.5);
    expect(estimateF0(sine(220), SR)!).toBeCloseTo(220, -0.5);
    expect(Math.abs(estimateF0(sine(120, 2048, 0.3, SR, true), SR)! - 120)).toBeLessThan(4);
    expect(Math.abs(estimateF0(sine(220, 2048, 0.3, 44100, true), 44100)! - 220)).toBeLessThan(6);
  });
  it('silence and noise are unvoiced', () => {
    expect(estimateF0(new Float32Array(2048), SR)).toBeNull();
    let s = 1;
    const noise = new Float32Array(2048).map(() => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5));
    expect(estimateF0(noise, SR)).toBeNull();
  });
});

describe('SpeakerPitch gender', () => {
  function feed(p: SpeakerPitch, from: number, to: number, buf: Float32Array | null) {
    for (let t = from; t < to; t += 0.05) p.addFrame(t, buf ? estimateF0(buf, SR) : null);
  }
  it('120 Hz → male, 220 Hz → female, silence → unknown (keeps previous)', () => {
    const p = new SpeakerPitch(fakeVideo());
    feed(p, 0, 2, sine(120));
    feed(p, 2, 4, sine(220));
    feed(p, 4, 6, new Float32Array(2048));
    expect(p.genderFor(line(0, 2))).toBe('male');
    expect(p.genderFor(line(2, 4))).toBe('female');
    expect(p.genderFor(line(4, 6))).toBe('unknown');
    expect(p.predicted()).toBe('unknown'); // first line: nothing known yet
    expect(p.observe(line(0, 2))).toBe('male');
    expect(p.observe(line(4, 6))).toBe('male'); // unknown keeps previous
    expect(p.observe(line(2, 4))).toBe('female');
    expect(p.predicted()).toBe('female');
  });
  it('< 30 % voiced frames → unknown', () => {
    const frames = Array.from({ length: 10 }, (_, i) => ({ t: i, f0: i < 2 ? 120 : null }));
    expect(classifyFrames(frames)).toBe('unknown');
    frames[2].f0 = 130;
    expect(classifyFrames(frames)).toBe('male');
  });
  it('caption labels override pitch', () => {
    const p = new SpeakerPitch(fakeVideo());
    feed(p, 0, 2, sine(120));
    expect(p.genderFor(line(0, 2, { gender: 'female' }))).toBe('female');
    expect(captionGender(line(0, 1, { text: '[Woman] hello' }))).toBe('female');
    expect(captionGender(line(0, 1, { text: 'bonjour', source: '(homme) salut' }))).toBe('male');
    expect(captionGender(line(0, 1))).toBe('unknown');
  });
  it('no WebAudio → start() false, genderFor unknown, setGain no-op', async () => {
    const p = new SpeakerPitch(fakeVideo());
    expect(p.start()).toBe(false);
    expect(await p.startAsync()).toBe(false);
    p.setGain(0.2);
    expect(p.hasGraph()).toBe(false);
    expect(p.genderFor(line(0, 1))).toBe('unknown');
  });
  it('never routes the video through a suspended AudioContext', async () => {
    vi.useFakeTimers();
    const createMediaElementSource = vi.fn();
    const ctx = { state: 'suspended', resume: vi.fn(async () => {}), close: vi.fn(async () => {}), createMediaElementSource } as unknown as AudioContext;
    const p = new SpeakerPitch(fakeVideo(), { createContext: () => ctx });
    const r = p.startAsync();
    await vi.advanceTimersByTimeAsync(1100);
    expect(await r).toBe(false);
    expect(createMediaElementSource).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('builds the graph on a running context and ducks through the GainNode', async () => {
    const gainParam = { value: 1, setValueAtTime: vi.fn(function (this: { value: number }, v: number) { this.value = v; }), cancelScheduledValues: vi.fn() };
    const node = () => ({ connect: vi.fn() });
    const ctx = {
      state: 'running', currentTime: 0, sampleRate: SR, destination: {},
      createMediaElementSource: vi.fn(node),
      createAnalyser: vi.fn(() => ({ ...node(), fftSize: 2048, getFloatTimeDomainData: (b: Float32Array) => b.set(sine(120)) })),
      createGain: vi.fn(() => ({ ...node(), gain: gainParam })),
    } as unknown as AudioContext;
    const p = new SpeakerPitch(fakeVideo(), { createContext: () => ctx });
    expect(await p.startAsync()).toBe(true);
    p.setGain(0.15);
    expect(gainParam.value).toBe(0.15);
    p.stop();
    expect(gainParam.value).toBe(1);
  });
});
