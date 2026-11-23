// E (v1.2): expressive post-processing DSP — TD-PSOLA pitch shift, contour expansion, energy, no clipping, no-op path.
import { describe, it, expect } from 'vitest';
import { expressify, f0Stats, psola, softLimit, trackF0 } from '../../src/offscreen/prosody-dsp';
import { estimateF0 } from '../../src/content/sync/pitch';
import type { ProsodyParams } from '../../src/shared/types';

const SR = 22050;

/** Voiced "vowel": harmonics with a formant-like envelope, F0 contour f(t) in Hz. */
function voiced(seconds: number, f: (t: number) => number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = f(t);
    ph += (2 * Math.PI * f0) / SR;
    let s = 0;
    for (let h = 1; h * f0 < 5000; h++) {
      const fh = h * f0;
      const env = Math.exp(-(((fh - 700) / 400) ** 2)) + 0.6 * Math.exp(-(((fh - 1200) / 500) ** 2)) + 0.15 / h;
      s += env * Math.sin(h * ph);
    }
    x[i] = s;
  }
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < n; i++) x[i] *= amp / m;
  return x;
}

/** Median F0 (autocorrelation, independent estimator from pitch.ts) over the middle of the buffer. */
function medianF0(x: Float32Array): number {
  const out: number[] = [];
  for (let a = Math.round(0.15 * x.length); a + 2048 < 0.85 * x.length; a += 512) {
    const f = estimateF0(x.subarray(a, a + 2048), SR);
    if (f) out.push(f);
  }
  out.sort((p, q) => p - q);
  return out[out.length >> 1];
}

const NOOP: ProsodyParams = { noiseScale: 0.667, noiseW: 0.8, pitchK: 1, meanShiftSt: 0, endShiftSt: 0, endMs: 300, gainDb: 0, emphasis: [] };
const semis = (a: number, b: number) => 12 * Math.log2(a / b);

describe('trackF0', () => {
  it('tracks a steady 150 Hz vowel', () => {
    const s = f0Stats(trackF0(voiced(1, () => 150), SR));
    expect(s.voiced).toBeGreaterThan(150);
    expect(Math.abs(semis(s.meanHz, 150))).toBeLessThan(0.3);
    expect(s.stdSt).toBeLessThan(0.3);
  });
});

describe('TD-PSOLA', () => {
  it.each([4, -3, 2.5, 7])('shifts F0 by %s semitones (±0.5) and keeps the duration', (shift) => {
    const x = voiced(1.2, () => 160);
    const tr = trackF0(x, SR);
    const y = psola(x, SR, tr, () => 2 ** (shift / 12));
    expect(Math.abs(y.length - x.length) / x.length).toBeLessThanOrEqual(0.02);
    const got = semis(medianF0(y), medianF0(x));
    expect(Math.abs(got - shift)).toBeLessThan(0.5);
  });

  it('ratio 1 reconstructs the input closely', () => {
    const x = voiced(0.8, (t) => 140 + 20 * t);
    const y = psola(x, SR, trackF0(x, SR), () => 1);
    let err = 0, en = 0;
    for (let i = 2000; i < x.length - 2000; i++) { err += (y[i] - x[i]) ** 2; en += x[i] ** 2; }
    expect(err / en).toBeLessThan(0.02);
  });
});

describe('expressify', () => {
  const contour = (t: number) => 180 * 2 ** ((2 * Math.sin(2 * Math.PI * 2.5 * t)) / 12); // ±2 st melody

  it('contour expansion (k = 1.6) increases the F0 std', () => {
    const x = voiced(1.6, contour);
    const r = expressify(x, SR, { ...NOOP, pitchK: 1.6 }, true);
    expect(r.pcm.length).toBe(x.length);
    expect(r.after!.stdSt).toBeGreaterThan(r.before.stdSt * 1.3);
    expect(r.after!.rangeSt).toBeGreaterThan(r.before.rangeSt * 1.25);
  });

  it('mean shift of +2 st raises the mean F0', () => {
    const x = voiced(1.2, () => 170);
    const r = expressify(x, SR, { ...NOOP, meanShiftSt: 2 }, true);
    expect(Math.abs(semis(r.after!.meanHz, r.before.meanHz) - 2)).toBeLessThan(0.5);
  });

  it('question: the end of the line rises', () => {
    const x = voiced(1.5, () => 170);
    const r = expressify(x, SR, { ...NOOP, endShiftSt: 4, endMs: 400 });
    const f = estimateF0(r.pcm.subarray(r.pcm.length - 2048), SR)!;
    expect(semis(f, 170)).toBeGreaterThan(2.5);
    const mid = estimateF0(r.pcm.subarray(8000, 10048), SR)!;
    expect(Math.abs(semis(mid, 170))).toBeLessThan(0.3); // only the end moves
  });

  it('+4 dB gain and a +6 dB emphasis on a loud line never clip', () => {
    const x = voiced(1.2, contour, 0.9);
    const r = expressify(x, SR, { ...NOOP, pitchK: 1.5, gainDb: 4, emphasis: [{ from: 0.3, to: 0.6, db: 6, st: 2 }] });
    let peak = 0;
    for (const v of r.pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.95 + 1e-6);
    // Louder overall (RMS up) even though peaks are limited.
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    expect(rms(r.pcm)).toBeGreaterThan(rms(x) * 1.1);
  });

  it('emphasis bump raises the level of the stressed span only', () => {
    const x = voiced(2, () => 170, 0.3);
    const r = expressify(x, SR, { ...NOOP, emphasis: [{ from: 0.5, to: 0.7, db: 6, st: 0 }] });
    const lvl = (a: Float32Array, p: number, q: number) => {
      const s = a.subarray(Math.round(p * a.length), Math.round(q * a.length));
      return Math.sqrt(s.reduce((acc, v) => acc + v * v, 0) / s.length);
    };
    expect(20 * Math.log10(lvl(r.pcm, 0.55, 0.65) / lvl(x, 0.55, 0.65))).toBeGreaterThan(5);
    expect(Math.abs(20 * Math.log10(lvl(r.pcm, 0.1, 0.3) / lvl(x, 0.1, 0.3)))).toBeLessThan(0.5);
  });

  it('soft limiter leaves quiet audio untouched', () => {
    const x = voiced(0.5, () => 200, 0.5);
    const y = Float32Array.from(x);
    softLimit(y, SR);
    expect(y).toEqual(x);
  });
});
