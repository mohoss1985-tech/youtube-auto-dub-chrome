// v1.2 (E): expressive post-processing of a Piper line (pure DSP, runs in the offscreen worker; no dependencies).
// 1. F0 track (normalised autocorrelation on a decimated copy) → smoothed contour in semitones.
// 2. Target contour: mean + shift + k·(f0 − mean) + final glide (question rise / statement fall) + accents on stressed words.
// 3. TD-PSOLA: pitch marks on glottal peaks, Hann grains of 2 periods re-spaced at the target period. Duration is
//    preserved exactly (output length = input length), so `knownMs` stays exact.
// 4. Energy: overall gain + bumps on stressed words (mapped from character position onto the speech-active timeline),
//    then a look-ahead soft limiter (no clipping).
import type { ProsodyParams } from '../shared/types';

export const F0_MIN_HZ = 70;
export const F0_MAX_HZ = 500;
/** v1.2.2 (M): F0 search range per voice gender (Hz). Male voices: 60–250 Hz avoids octave-up picks on strong H2. */
export const F0_RANGE: Readonly<Record<'male' | 'female', readonly [number, number]>> = { male: [60, 250], female: [100, 500] };
/** Analysis hop (s). */
export const HOP_S = 0.005;
const WIN_S = 0.032;
const VOICED_CORR = 0.6;
const LIMIT_CEIL = 0.95;

export interface F0Track {
  /** Hop in samples (of the original rate). */
  hop: number;
  /** F0 per hop in Hz; 0 = unvoiced. */
  f0: Float32Array;
}

/** F0 per 5 ms hop. Clean single-speaker synthetic speech: a plain autocorrelation tracker is reliable. */
export function trackF0(x: Float32Array, sr: number, minHz = F0_MIN_HZ, maxHz = F0_MAX_HZ): F0Track {
  // Decimate to ~11 kHz (box filter) — plenty for F0 ≤ 500 Hz, and 4× cheaper at 22 kHz.
  const dec = Math.max(1, Math.floor(sr / 11025));
  const y = dec === 1 ? x : decimate(x, dec);
  const fs = sr / dec;
  const hop = Math.max(1, Math.round(sr * HOP_S));
  const n = Math.ceil(x.length / hop);
  const f0 = new Float32Array(n);
  const win = Math.round(fs * WIN_S);
  const minLag = Math.max(2, Math.floor(fs / maxHz));
  const maxLag = Math.ceil(fs / minHz);
  let peak = 0;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  const silent = Math.max(1e-4, peak * 0.03);
  const corr = new Float32Array(maxLag + 2);
  for (let k = 0; k < n; k++) {
    const c0 = Math.round((k * hop) / dec) - (win >> 1);
    const a = Math.max(0, Math.min(c0, y.length - win - maxLag - 3));
    if (a + win + maxLag + 2 >= y.length) continue;
    let e0 = 0;
    for (let i = 0; i < win; i++) { const v = y[a + i]; e0 += v * v; }
    if (Math.sqrt(e0 / win) < silent) continue;
    let best = -1;
    let e1 = 0;
    for (let i = 0; i < win; i++) { const v = y[a + minLag - 1 + i]; e1 += v * v; }
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let c = 0;
      for (let i = 0; i < win; i++) c += y[a + i] * y[a + lag + i];
      const r = e0 > 0 && e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
      corr[lag] = r;
      if (lag >= minLag && lag <= maxLag && r > best) best = r;
      // slide energy of the lagged window
      const out = y[a + lag], inn = y[a + lag + win];
      e1 += inn * inn - out * out;
    }
    if (best < VOICED_CORR) continue;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const r = corr[lag];
      if (r >= best * 0.92 && r >= corr[lag - 1] && r >= corr[lag + 1]) {
        const p = corr[lag - 1], q = corr[lag + 1];
        const den = p - 2 * r + q;
        const sh = den !== 0 ? (0.5 * (p - q)) / den : 0;
        f0[k] = fs / (lag + (Math.abs(sh) < 1 ? sh : 0));
        break;
      }
    }
  }
  cleanTrack(f0);
  return { hop, f0 };
}

function decimate(x: Float32Array, d: number): Float32Array {
  const out = new Float32Array(Math.floor(x.length / d));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) s += x[i * d + j];
    out[i] = s / d;
  }
  return out;
}

/** Remove isolated voiced frames and octave jumps; median-smooth voiced runs. In place. */
function cleanTrack(f0: Float32Array): void {
  const n = f0.length;
  // Voiced runs shorter than 3 frames → unvoiced.
  for (let i = 0; i < n;) {
    if (!f0[i]) { i++; continue; }
    let j = i;
    while (j < n && f0[j]) j++;
    if (j - i < 3) for (let k = i; k < j; k++) f0[k] = 0;
    i = j;
  }
  // Octave errors against a local median.
  const med = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!f0[i]) continue;
    const w: number[] = [];
    for (let k = Math.max(0, i - 6); k <= Math.min(n - 1, i + 6); k++) if (f0[k]) w.push(f0[k]);
    w.sort((a, b) => a - b);
    med[i] = w[w.length >> 1];
  }
  for (let i = 0; i < n; i++) {
    if (!f0[i]) continue;
    const r = f0[i] / med[i];
    if (r > 1.7) f0[i] /= 2;
    else if (r < 0.6) f0[i] *= 2;
  }
  // 5-point median.
  const src = Float32Array.from(f0);
  for (let i = 0; i < n; i++) {
    if (!src[i]) continue;
    const w: number[] = [];
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) if (src[k]) w.push(src[k]);
    w.sort((a, b) => a - b);
    f0[i] = w[w.length >> 1];
  }
}

const st = (hz: number) => 12 * Math.log2(hz / 100);

/** Semitone statistics of the voiced frames: std and p95−p5 range. */
export function f0Stats(track: F0Track): { voiced: number; meanHz: number; stdSt: number; rangeSt: number } {
  const v = [...track.f0].filter((x) => x > 0).map(st);
  if (!v.length) return { voiced: 0, meanHz: 0, stdSt: 0, rangeSt: 0 };
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { voiced: v.length, meanHz: 100 * 2 ** (m / 12), stdSt: sd, rangeSt: q(0.95) - q(0.05) };
}

// ---------------------------------------------------------------- TD-PSOLA

interface Marks { at: Int32Array; period: Float32Array; voiced: Uint8Array }

function f0At(track: F0Track, i: number): number {
  const k = Math.min(track.f0.length - 1, Math.max(0, Math.round(i / track.hop)));
  return track.f0[k];
}

/** Lag (samples, within ±15 % of `P`) that best aligns one period starting at `m` with the next one. */
function bestPeriod(x: Float32Array, m: number, P: number): number {
  const half = Math.round(P / 2);
  const lo = Math.max(2, Math.floor(P * 0.85)), hi = Math.ceil(P * 1.15);
  if (m - half < 0 || m + hi + half >= x.length) return P;
  let best = P, bestR = -Infinity;
  for (let d = lo; d <= hi; d++) {
    let c = 0, e = 0;
    for (let j = -half; j < half; j++) { const b = x[m + d + j]; c += x[m + j] * b; e += b * b; }
    const r = e > 0 ? c / Math.sqrt(e) : 0;
    if (r > bestR) { bestR = r; best = d; }
  }
  return best;
}

/**
 * Analysis pitch marks. Voiced runs: the first mark on the biggest peak of the first period, then one *measured* period
 * apart (cross-correlation of consecutive periods → phase-consistent grains). Unvoiced: every 5 ms.
 */
export function pitchMarks(x: Float32Array, sr: number, track: F0Track): Marks {
  const at: number[] = [];
  const period: number[] = [];
  const voiced: number[] = [];
  const uvP = Math.round(sr * 0.005);
  let i = 0;
  let prevVoiced = false;
  while (i < x.length) {
    const f = f0At(track, i);
    if (f > 0) {
      const P0 = sr / f;
      let m = Math.round(i);
      if (!prevVoiced) {
        for (let j = m; j < Math.min(x.length, m + P0); j++) if (x[j] > x[m]) m = j;
      }
      if (at.length && m <= at[at.length - 1]) m = at[at.length - 1] + 1;
      const P = bestPeriod(x, m, P0);
      at.push(m); period.push(P); voiced.push(1);
      i = m + P;
      prevVoiced = true;
    } else {
      at.push(Math.round(i)); period.push(uvP); voiced.push(0);
      i += uvP;
      prevVoiced = false;
    }
  }
  return { at: Int32Array.from(at), period: Float32Array.from(period), voiced: Uint8Array.from(voiced) };
}

/**
 * TD-PSOLA with a per-mark pitch ratio (target F0 / source F0). Output has exactly the input length.
 * `ratioAt(markIndex)` is only asked for voiced marks.
 */
export function psola(x: Float32Array, sr: number, track: F0Track, ratioAt: (i: number, marks: Marks) => number): Float32Array {
  const n = x.length;
  const marks = pitchMarks(x, sr, track);
  const out = new Float32Array(n);
  const wsum = new Float32Array(n);
  const M = marks.at.length;
  if (!M) return Float32Array.from(x);
  const ratio = new Float32Array(M);
  for (let k = 0; k < M; k++) {
    if (!marks.voiced[k]) { ratio[k] = 1; continue; }
    // v1.2.2 (M) octave guard: a mark whose measured period disagrees with the F0 track by ≥ 0.7 octave is a
    // tracking error (typical on low male F0 with a strong 2nd harmonic) → leave that grain at its own pitch.
    const f = f0At(track, marks.at[k]);
    const bad = !(f > 0) || Math.abs(Math.log2(sr / f / marks.period[k])) > 0.7;
    ratio[k] = bad ? 1 : Math.min(2, Math.max(0.5, ratioAt(k, marks)));
  }
  smoothRatios(ratio, marks.voiced);
  let t = marks.at[0];
  // Copy anything before the first mark.
  for (let i = 0; i < Math.min(n, t); i++) { out[i] = x[i]; wsum[i] = 1; }
  let k = 0;
  while (t < n) {
    while (k + 1 < M && Math.abs(marks.at[k + 1] - t) <= Math.abs(marks.at[k] - t)) k++;
    const P = Math.max(2, marks.period[k]);
    const c = marks.at[k];
    // v1.2.2 (M): pitch-synchronous asymmetric Hann grain: left half = distance to the previous mark, right half =
    // distance to the next one (each clamped to 0.5–1.5 P), so a grain never reaches into a third period.
    const Ll = Math.max(2, Math.round(Math.min(1.5 * P, Math.max(0.5 * P, k > 0 ? c - marks.at[k - 1] : P))));
    const Lr = Math.max(2, Math.round(Math.min(1.5 * P, Math.max(0.5 * P, k + 1 < M ? marks.at[k + 1] - c : P))));
    const ti = Math.round(t);
    for (let j = -Ll; j <= Lr; j++) {
      const s = c + j, d = ti + j;
      if (s < 0 || s >= n || d < 0 || d >= n) continue;
      const w = 0.5 * (1 + Math.cos((Math.PI * j) / (j < 0 ? Ll : Lr)));
      out[d] += w * x[s];
      wsum[d] += w;
    }
    t += P / ratio[k];
  }
  // v1.2.2 (M): normalise the overlap-add by the window sum everywhere (floor 0.35). v1.2 left the dips between
  // lowered-pitch grains alone → amplitude buzz at F0 rate, worst on male voices (k expansion lowers half of each contour).
  for (let i = 0; i < n; i++) if (wsum[i] > 1e-6) out[i] /= Math.max(WSUM_FLOOR, wsum[i]);
  return out;
}

const WSUM_FLOOR = 0.35;
/** Max pitch-ratio change between consecutive voiced grains (semitones): no pitch steps inside a voiced run. */
const MAX_RATIO_STEP_ST = 0.6;

/** 3-point median, then slew-limit the per-grain ratios of each voiced run (both directions). In place. */
function smoothRatios(r: Float32Array, voiced: Uint8Array): void {
  const M = r.length;
  const src = Float32Array.from(r);
  for (let k = 1; k + 1 < M; k++) {
    if (!voiced[k] || !voiced[k - 1] || !voiced[k + 1]) continue;
    const a = src[k - 1], b = src[k], c = src[k + 1];
    r[k] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  const step = 2 ** (MAX_RATIO_STEP_ST / 12);
  for (let k = 1; k < M; k++) if (voiced[k] && voiced[k - 1]) r[k] = Math.min(r[k - 1] * step, Math.max(r[k - 1] / step, r[k]));
  for (let k = M - 2; k >= 0; k--) if (voiced[k] && voiced[k + 1]) r[k] = Math.min(r[k + 1] * step, Math.max(r[k + 1] / step, r[k]));
}

// ---------------------------------------------------------------- the expressive pass

/** Speech-active timeline: maps a character fraction of the text to a sample index (pauses are skipped). */
export function charToSample(x: Float32Array, sr: number): (q: number) => number {
  const hop = Math.max(1, Math.round(sr * 0.01));
  const n = Math.ceil(x.length / hop);
  const rms = new Float32Array(n);
  let max = 0;
  for (let k = 0; k < n; k++) {
    let s = 0;
    const a = k * hop, b = Math.min(x.length, a + hop);
    for (let i = a; i < b; i++) s += x[i] * x[i];
    rms[k] = Math.sqrt(s / Math.max(1, b - a));
    max = Math.max(max, rms[k]);
  }
  const cum = new Float32Array(n + 1);
  for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + (rms[k] > max * 0.08 ? 1 : 0);
  const total = cum[n] || 1;
  return (q: number) => {
    const target = Math.min(1, Math.max(0, q)) * total;
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid + 1] < target) lo = mid + 1; else hi = mid; }
    return Math.min(x.length, lo * hop);
  };
}

/** Raised-cosine bump 0..1 over [a, b] with `ramp`-sample edges. */
function bump(i: number, a: number, b: number, ramp: number): number {
  if (i <= a - ramp || i >= b + ramp) return 0;
  if (i < a) return 0.5 * (1 - Math.cos((Math.PI * (i - (a - ramp))) / ramp));
  if (i > b) return 0.5 * (1 + Math.cos((Math.PI * (i - b)) / ramp));
  return 1;
}

/** min of a[i−r .. i+r] for every i (monotonic deque, O(n)). */
function slidingMin(a: Float32Array, r: number): Float32Array {
  const n = a.length;
  const out = new Float32Array(n);
  const dq = new Int32Array(n);
  let h = 0, t = 0;
  for (let j = 0; j < n + r; j++) {
    if (j < n) {
      while (t > h && a[dq[t - 1]] >= a[j]) t--;
      dq[t++] = j;
    }
    const i = j - r;
    if (i < 0) continue;
    while (dq[h] < i - r) h++;
    out[i] = a[dq[h]];
  }
  return out;
}

/** Look-ahead soft limiter: smooth gain so that |y| ≤ ceil, no hard clipping. In place. */
export function softLimit(y: Float32Array, sr: number, ceil = LIMIT_CEIL): Float32Array {
  const n = y.length;
  const L = Math.max(1, Math.round(sr * 0.003));
  let need = false;
  for (let i = 0; i < n; i++) if (Math.abs(y[i]) > ceil) { need = true; break; }
  if (!need) return y;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = Math.abs(y[i]); g[i] = a > ceil ? ceil / a : 1; }
  // Min over ±2L, then moving average over ±L (≤ the needed gain everywhere).
  const mn = slidingMin(g, 2 * L);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + mn[i];
  const W = 2 * L + 1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - L), b = Math.min(n - 1, i + L);
    const missing = W - (b - a + 1); // outside the buffer counts as gain 1
    y[i] *= (pre[b + 1] - pre[a] + missing) / W;
  }
  for (let i = 0; i < n; i++) y[i] = Math.max(-ceil, Math.min(ceil, y[i]));
  return y;
}

export interface ExpressResult {
  pcm: Float32Array;
  /** Voiced-frame F0 stats before/after (semitones), for diagnostics. */
  before: ReturnType<typeof f0Stats>;
  after?: ReturnType<typeof f0Stats>;
}

/**
 * Apply ProsodyParams to one synthesized line (mono float PCM). Never changes the length.
 * `measureAfter` re-tracks the output F0 (tests/diagnostics; costs one more analysis).
 */
export function expressify(pcm: Float32Array, sr: number, p: ProsodyParams, measureAfter = false, opts: ExpressOptions = {}): ExpressResult {
  const n = pcm.length;
  const [minHz, maxHz] = opts.gender ? F0_RANGE[opts.gender] : [F0_MIN_HZ, F0_MAX_HZ];
  const track = trackF0(pcm, sr, minHz, maxHz);
  const before = f0Stats(track);
  const c2s = charToSample(pcm, sr);
  const spans = p.emphasis.map((e) => ({ a: c2s(e.from), b: c2s(e.to), db: e.db, st: e.st }));
  const ramp = Math.round(sr * 0.03);
  let y = pcm;

  // ---- F0 contour
  const wantPitch = before.voiced >= 4 && (Math.abs(p.pitchK - 1) > 1e-3 || Math.abs(p.meanShiftSt) > 1e-3 || Math.abs(p.endShiftSt) > 1e-3 || spans.some((s) => s.st > 0));
  if (wantPitch) {
    // Smoothed contour (st) of voiced frames; the line mean; the end of voiced speech.
    const f = track.f0;
    const sm = new Float32Array(f.length);
    for (let k = 0; k < f.length; k++) {
      if (!f[k]) continue;
      let s = 0, c = 0;
      for (let j = Math.max(0, k - 4); j <= Math.min(f.length - 1, k + 4); j++) if (f[j]) { s += st(f[j]); c++; }
      sm[k] = s / c;
    }
    let mean = 0, cnt = 0, lastVoiced = 0;
    for (let k = 0; k < f.length; k++) if (f[k]) { mean += sm[k]; cnt++; lastVoiced = k; }
    mean /= Math.max(1, cnt);
    const endS = (lastVoiced + 1) * track.hop;
    const endLen = Math.max(1, Math.round((p.endMs / 1000) * sr));
    y = psola(pcm, sr, track, (i, marks) => {
      const at = marks.at[i];
      const k = Math.min(f.length - 1, Math.round(at / track.hop));
      const s = sm[k] || (f[k] ? st(f[k]) : mean);
      let target = mean + p.meanShiftSt + p.pitchK * (s - mean);
      const u = (at - (endS - endLen)) / endLen;
      if (u > 0) target += p.endShiftSt * Math.min(1, u) ** 1.5;
      for (const sp of spans) if (sp.st > 0) target += sp.st * bump(at, sp.a, sp.b, ramp);
      return 2 ** ((target - s) / 12);
    });
  } else {
    y = Float32Array.from(pcm);
  }

  // ---- energy
  if (Math.abs(p.gainDb) > 1e-3 || spans.some((s) => s.db > 0)) {
    const g0 = p.gainDb;
    for (let i = 0; i < n; i++) {
      let db = g0;
      for (const sp of spans) if (sp.db > 0) db += sp.db * bump(i, sp.a, sp.b, ramp);
      if (db !== 0) y[i] *= 10 ** (db / 20);
    }
  }
  softLimit(y, sr);
  return { pcm: y, before, after: measureAfter ? f0Stats(trackF0(y, sr, minHz, maxHz)) : undefined };
}

export interface ExpressOptions {
  /** Voice gender: picks the F0 search range (male 60–250 Hz). Absent = the v1.2 range (70–500 Hz). */
  gender?: 'male' | 'female';
}

/** Max contour expansion for male voices: PSOLA on a low F0 gets rough/cartoonish above ~1.4. */
export const MALE_MAX_K = 1.4;

/**
 * v1.2.2 (M): adapt the generic ProsodyParams (built against Piper's stock 0.667 / 0.8 noise) to one voice:
 * - noise relative to the model's own defaults (Siwis ships 0.5 / 0.333, MLS 0.333 / 0.333, Tom 0.667 / 0.8);
 *   male voices never get MORE noise than their defaults (measured: higher noise_scale = lower HNR, more dips);
 * - male: contour expansion scaled into 1…1.4 and the mean upward shift ×0.6 (a pushed-up male voice sounds strained).
 */
export function voiceProsody(p: ProsodyParams, gender: 'male' | 'female' | undefined, inf: { noise_scale?: number; noise_w?: number } = {}): ProsodyParams {
  const ns0 = inf.noise_scale ?? 0.667, nw0 = inf.noise_w ?? 0.8;
  const male = gender === 'male';
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const noiseScale = r3(clamp(ns0 * (p.noiseScale / 0.667), ns0 * 0.6, ns0 * (male ? 1 : 1.3)));
  const noiseW = r3(clamp(nw0 * (p.noiseW / 0.8), nw0 * 0.6, nw0 * (male ? 1.05 : 1.3)));
  if (!male) return { ...p, noiseScale, noiseW };
  return {
    ...p, noiseScale, noiseW,
    pitchK: r3(1 + Math.max(0, p.pitchK - 1) * ((MALE_MAX_K - 1) / 0.8)),
    meanShiftSt: r3(p.meanShiftSt > 0 ? p.meanShiftSt * 0.6 : p.meanShiftSt),
    emphasis: p.emphasis.map((e) => ({ ...e, st: r3(e.st * 0.7) })),
  };
}
