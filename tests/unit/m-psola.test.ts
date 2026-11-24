// M (v1.2.2): male-voice DSP. TD-PSOLA on a synthetic 90 Hz voiced signal: no octave error, F0 shift within
// ±0.5 st, no discontinuity, exact duration, no amplitude holes when lowering pitch. Plus the per-voice prosody
// mapping (male k ≤ 1.4, noise ≤ model defaults) and the line edges (tail margin + ≥ 20 ms fade-out).
import { describe, it, expect } from 'vitest';
import { F0_RANGE, MALE_MAX_K, expressify, f0Stats, psola, trackF0, voiceProsody } from '../../src/offscreen/prosody-dsp';
import { fadeEdges, trimSilence } from '../../src/offscreen/piper';
import type { ProsodyParams } from '../../src/shared/types';

const SR = 22050;
const F0 = 90;

/** Male-like vowel: rich harmonics (strong H2 → octave-error bait), formant envelope, slow F0 contour f(t). */
function maleVowel(seconds: number, f: (t: number) => number, sr = SR, amp = 0.5): Float32Array {
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f0 = f(i / sr);
    ph += (2 * Math.PI * f0) / sr;
    let s = 0;
    for (let h = 1; h * f0 < 4500; h++) {
      const fh = h * f0;
      const env = (h === 2 ? 1.4 : 0) + Math.exp(-(((fh - 550) / 300) ** 2)) + 0.7 * Math.exp(-(((fh - 1100) / 400) ** 2)) + 0.2 / h;
      s += env * Math.sin(h * ph);
    }
    x[i] = s;
  }
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < n; i++) x[i] *= amp / m;
  return x;
}

/** Independent F0 estimate: normalised autocorrelation, 50–400 Hz, the first peak ≥ 0.9 × the best (no sub-octave). */
function acF0(x: Float32Array, sr = SR): number {
  const out: number[] = [];
  const W = Math.round(sr * 0.06);
  for (let a = Math.round(0.15 * x.length); a + W + sr / 50 < 0.85 * x.length; a += Math.round(sr * 0.02)) {
    const r: number[] = [];
    const lo = Math.floor(sr / 400), hi = Math.ceil(sr / 50);
    for (let lag = lo; lag <= hi; lag++) {
      let c = 0, e0 = 0, e1 = 0;
      for (let i = 0; i < W; i++) { const u = x[a + i], v = x[a + i + lag]; c += u * v; e0 += u * u; e1 += v * v; }
      r.push(c / Math.sqrt(e0 * e1 + 1e-12));
    }
    const best = Math.max(...r);
    for (let k = 1; k + 1 < r.length; k++) {
      if (r[k] >= 0.9 * best && r[k] >= r[k - 1] && r[k] >= r[k + 1]) {
        const p = r[k - 1], q = r[k + 1], den = p - 2 * r[k] + q;
        out.push(sr / (lo + k + (den ? (0.5 * (p - q)) / den : 0)));
        break;
      }
    }
  }
  out.sort((p, q) => p - q);
  return out[out.length >> 1];
}

const semis = (a: number, b: number) => 12 * Math.log2(a / b);
const maxJump = (x: Float32Array, a = 0, b = x.length) => { let m = 0; for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
/** RMS of each pitch period (steady middle part): min / max. Holes between grains show up as a low ratio. */
function periodRmsRatio(y: Float32Array, f0: number, sr = SR): number {
  const P = Math.round(sr / f0);
  const vals: number[] = [];
  for (let a = Math.round(0.2 * y.length); a + P < 0.8 * y.length; a += P) {
    let s = 0;
    for (let i = a; i < a + P; i++) s += y[i] * y[i];
    vals.push(Math.sqrt(s / P));
  }
  return Math.min(...vals) / Math.max(...vals);
}

const NOOP: ProsodyParams = { noiseScale: 0.667, noiseW: 0.8, pitchK: 1, meanShiftSt: 0, endShiftSt: 0, endMs: 300, gainDb: 0, emphasis: [] };

describe('M: F0 tracking of a low male voice (90 Hz)', () => {
  it('male range 60–250 Hz: every voiced frame near 90 Hz (no octave error)', () => {
    const x = maleVowel(1.2, () => F0);
    const [lo, hi] = F0_RANGE.male;
    const tr = trackF0(x, SR, lo, hi);
    const v = [...tr.f0].filter((f) => f > 0);
    expect(v.length).toBeGreaterThan(150);
    for (const f of v) expect(Math.abs(semis(f, F0))).toBeLessThan(1);
    expect(Math.abs(semis(f0Stats(tr).meanHz, F0))).toBeLessThan(0.3);
  });
  it('the reference estimator agrees (the test signal really is 90 Hz)', () => {
    expect(Math.abs(semis(acF0(maleVowel(1, () => F0)), F0))).toBeLessThan(0.3);
  });
});

describe('M: TD-PSOLA on a 90 Hz voice', () => {
  const [lo, hi] = F0_RANGE.male;
  it.each([3, -3, 2, -2, 5])('shifts by %s st (±0.5), exact length, no octave error, no discontinuity', (shift) => {
    const x = maleVowel(1.2, () => F0);
    const y = psola(x, SR, trackF0(x, SR, lo, hi), () => 2 ** (shift / 12));
    expect(y.length).toBe(x.length);
    const got = semis(acF0(y), acF0(x));
    expect(Math.abs(got - shift)).toBeLessThan(0.5);
    // Sample-to-sample jumps: at most what the pitch change itself implies (+ 30 % margin).
    const a = Math.round(0.05 * x.length), b = Math.round(0.95 * x.length);
    expect(maxJump(y, a, b)).toBeLessThan(maxJump(x, a, b) * Math.max(1, 2 ** (shift / 12)) * 1.3);
  });
  it('lowering pitch leaves no holes between grains: steady per-period RMS, level kept within 1 dB', () => {
    const x = maleVowel(1.2, () => F0);
    const down = 2 ** (-3 / 12);
    const y = psola(x, SR, trackF0(x, SR, lo, hi), () => down);
    expect(periodRmsRatio(y, F0 * down)).toBeGreaterThan(0.95);
    const rms = (z: Float32Array) => Math.sqrt(z.subarray(z.length * 0.2, z.length * 0.8).reduce((a, v) => a + v * v, 0) / (z.length * 0.6));
    expect(Math.abs(20 * Math.log10(rms(y) / rms(x)))).toBeLessThan(1);
  });
  it('ratio 1 reconstructs the 90 Hz input closely', () => {
    const x = maleVowel(0.8, (t) => F0 + 10 * t);
    const y = psola(x, SR, trackF0(x, SR, lo, hi), () => 1);
    let err = 0, en = 0;
    for (let i = 2000; i < x.length - 2000; i++) { err += (y[i] - x[i]) ** 2; en += x[i] ** 2; }
    expect(err / en).toBeLessThan(0.02);
  });
  it('a ratio that flips every grain is slew-limited (no pitch steps > ~1 st)', () => {
    const x = maleVowel(1.2, () => F0);
    const y = psola(x, SR, trackF0(x, SR, lo, hi), (i) => (i % 2 ? 2 ** (4 / 12) : 1));
    const tr = trackF0(y, SR, lo, hi);
    let worst = 0, prev = 0;
    for (const f of tr.f0) { if (f > 0 && prev > 0) worst = Math.max(worst, Math.abs(semis(f, prev))); prev = f; }
    expect(worst).toBeLessThan(1.5);
  });
  it('expressify (male) keeps the duration exact and the F0 in the male range', () => {
    const x = maleVowel(1.5, (t) => F0 * 2 ** ((1.5 * Math.sin(2 * Math.PI * 2 * t)) / 12));
    const p = voiceProsody({ ...NOOP, pitchK: 1.8, meanShiftSt: 3, endShiftSt: -2, endMs: 350 }, 'male');
    const r = expressify(x, SR, p, true, { gender: 'male' });
    expect(r.pcm.length).toBe(x.length);
    expect(r.after!.meanHz).toBeGreaterThan(80);
    expect(r.after!.meanHz).toBeLessThan(140);
    expect(Math.abs(semis(r.before.meanHz, F0))).toBeLessThan(0.5);
  });
});

describe('M: per-voice prosody', () => {
  const lively: ProsodyParams = { ...NOOP, noiseScale: 0.9, noiseW: 1.1, pitchK: 1.8, meanShiftSt: 3, emphasis: [{ from: 0.2, to: 0.4, db: 6, st: 2.5 }] };
  it('male: k ≤ 1.4, smaller upward shift and accents, noise never above the model defaults', () => {
    const p = voiceProsody(lively, 'male', { noise_scale: 0.667, noise_w: 0.8 });
    expect(p.pitchK).toBeLessThanOrEqual(MALE_MAX_K + 1e-9);
    expect(p.pitchK).toBeGreaterThan(1.3);
    expect(p.meanShiftSt).toBeCloseTo(1.8, 3);
    expect(p.emphasis[0].st).toBeLessThan(2.5);
    expect(p.noiseScale).toBeLessThanOrEqual(0.667);
    expect(p.noiseW).toBeLessThanOrEqual(0.84 + 1e-9);
  });
  it('noise is relative to the model defaults (Siwis 0.5 / 0.333), female contour untouched', () => {
    const p = voiceProsody(lively, 'female', { noise_scale: 0.5, noise_w: 0.333 });
    expect(p.pitchK).toBe(1.8);
    expect(p.noiseScale).toBeLessThanOrEqual(0.65);
    expect(p.noiseW).toBeLessThanOrEqual(0.44);
    expect(voiceProsody(NOOP, 'female', { noise_scale: 0.5, noise_w: 0.333 })).toMatchObject({ noiseScale: 0.5, noiseW: 0.333 });
  });
});

describe('M: line edges are never cut', () => {
  it('trimSilence keeps a 60 ms tail margin (30 ms lead) by default', () => {
    const pcm = new Float32Array(SR);
    pcm.fill(0.2, 5000, 6000);
    const t = trimSilence(pcm, SR);
    expect(t.length).toBe(1000 + Math.round(SR * 0.03) + Math.round(SR * 0.06));
  });
  it('fadeEdges: ≥ 20 ms raised-cosine fade-out ending on 0, same length', () => {
    const x = new Float32Array(SR).fill(0.5);
    const y = fadeEdges(Float32Array.from(x), SR);
    expect(y.length).toBe(x.length);
    expect(Math.abs(y[y.length - 1])).toBeLessThan(1e-6);
    expect(Math.abs(y[0])).toBeLessThan(1e-6);
    expect(y[y.length - 1 - Math.round(SR * 0.02)]).toBeLessThan(0.5); // still fading 20 ms before the end
    expect(y[y.length - 1 - Math.round(SR * 0.03)]).toBeCloseTo(0.5, 5);
    expect(maxJump(y)).toBeLessThan(0.01);
  });
});
