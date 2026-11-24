// v1.2.2 (M): objective audio-quality proxies for a rendered dub line (Node side of the e2e; pure TS).
// Clicks / jumps / zero-gaps / clipping / tail fade / F0 range + octave jumps / HNR (clarity) / spectral flatness.
import { f0Stats, trackF0, F0_RANGE } from '../../src/offscreen/prosody-dsp';

export interface LineMetrics {
  sr: number;
  ms: number;
  peak: number;
  /** % of samples at |x| ≥ 0.985 (hard clipping proxy). */
  clipPct: number;
  /** Largest sample-to-sample jump, as a multiple of the line's median |Δx| of loud frames (scale-free across sample rates). */
  maxJump: number;
  /** Clicks: isolated second-difference spikes > 8× their local (5 ms) RMS, inside speech. */
  clicks: number;
  /** Runs ≥ 1.5 ms of near-zero samples (|x| < 0.002) surrounded by speech (PSOLA holes / chunk gaps). */
  gaps: number;
  /** Peak-normalised RMS of the last 10 ms (dB re line RMS): ≥ −20 dB means the line ends while still sounding = "cut". */
  tailDb: number;
  /** |last sample| (an abrupt stop leaves a step). */
  lastSample: number;
  meanHz: number;
  rangeSt: number;
  stdSt: number;
  /** Voiced frames whose F0 jumps by ≥ 0.8 octave from the previous voiced frame (octave errors / warble). */
  octaveJumps: number;
  /** Choppiness: speech → near-silence (−45 dB re line peak, 2.5 ms frames) transitions per second ("cutting"). */
  breaksPerS: number;
  /** Short holes inside speech: a 2.5 ms frame < −35 dB with loud speech (≥ −20 dB) within 15 ms on both sides. */
  dips: number;
  /** Mean harmonics-to-noise ratio of voiced 40 ms frames (dB; higher = clearer). */
  hnrDb: number;
  /** Median spectral flatness of voiced frames 0.1–5 kHz (lower = more tonal / less hiss). */
  flatness: number;
}

export function wavToFloat(buf: Buffer): { pcm: Float32Array; sr: number } {
  const sr = buf.readUInt32LE(24);
  const n = buf.readUInt32LE(40) / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(44 + 2 * i) / 32768;
  return { pcm, sr };
}

export function floatToWav(pcm: Float32Array, sr: number): Buffer {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + 2 * i);
  return b;
}

/** Linear resample (for concatenating voices of different rates into one listening file). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.round((x.length * to) / from);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * from) / to, a = Math.floor(p), f = p - a;
    y[i] = (x[a] ?? 0) * (1 - f) + (x[a + 1] ?? x[a] ?? 0) * f;
  }
  return y;
}

function rmsEnv(x: Float32Array, hop: number): Float32Array {
  const n = Math.ceil(x.length / hop);
  const e = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    const a = k * hop, b = Math.min(x.length, a + hop);
    for (let i = a; i < b; i++) s += x[i] * x[i];
    e[k] = Math.sqrt(s / Math.max(1, b - a));
  }
  return e;
}

/** Real FFT magnitude² of a power-of-two frame (iterative radix-2). */
function powerSpectrum(frame: Float32Array): Float64Array {
  const n = frame.length;
  const re = Float64Array.from(frame), im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr; im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr; im[i + k] += ti;
      }
    }
  }
  const p = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

export function measure(pcm: Float32Array, sr: number, gender: 'male' | 'female' = 'male'): LineMetrics {
  const n = pcm.length;
  let peak = 0, clip = 0;
  for (const v of pcm) { const a = Math.abs(v); peak = Math.max(peak, a); if (a >= 0.985) clip++; }
  const hop5 = Math.round(sr * 0.005);
  const env = rmsEnv(pcm, hop5);
  let envMax = 0;
  for (const e of env) envMax = Math.max(envMax, e);
  const loud = (i: number) => env[Math.min(env.length - 1, Math.floor(i / hop5))] > envMax * 0.05;

  // Jumps (scale-free): max |Δx| over the median |Δx| of loud samples.
  const d: number[] = [];
  let maxD = 0;
  for (let i = 1; i < n; i++) { const a = Math.abs(pcm[i] - pcm[i - 1]); if (a > maxD) maxD = a; if (loud(i)) d.push(a); }
  d.sort((a, b) => a - b);
  const medD = d.length ? d[d.length >> 1] : 1e-9;

  // Clicks: second-difference spikes far above their local 5 ms RMS.
  const d2 = new Float32Array(n);
  for (let i = 2; i < n; i++) d2[i] = pcm[i] - 2 * pcm[i - 1] + pcm[i - 2];
  const W = hop5;
  let clicks = 0, last = -W;
  let acc = 0;
  for (let i = 0; i < Math.min(n, 2 * W); i++) acc += d2[i] * d2[i];
  for (let i = W; i < n - W; i++) {
    acc += d2[i + W] * d2[i + W] - (i - W - 1 >= 0 ? d2[i - W - 1] * d2[i - W - 1] : 0);
    const local = Math.sqrt(Math.max(0, acc) / (2 * W + 1));
    if (Math.abs(d2[i]) > 8 * local && Math.abs(d2[i]) > 0.02 && i - last > W) { clicks++; last = i; }
  }

  // Zero gaps inside speech.
  const minRun = Math.round(sr * 0.0015), ctx = Math.round(sr * 0.015);
  let gaps = 0;
  for (let i = 0; i < n;) {
    if (Math.abs(pcm[i]) >= 0.002) { i++; continue; }
    let j = i;
    while (j < n && Math.abs(pcm[j]) < 0.002) j++;
    if (j - i >= minRun && i - ctx > 0 && j + ctx < n && loud(i - ctx) && loud(j + ctx)) gaps++;
    i = j;
  }

  // Tail: last 10 ms vs the line's speech RMS.
  let sp = 0, spn = 0;
  for (const e of env) if (e > envMax * 0.05) { sp += e * e; spn++; }
  const speechRms = Math.sqrt(sp / Math.max(1, spn));
  const t10 = Math.round(sr * 0.01);
  let ts = 0;
  for (let i = Math.max(0, n - t10); i < n; i++) ts += pcm[i] * pcm[i];
  const tailDb = 20 * Math.log10(Math.max(1e-6, Math.sqrt(ts / t10)) / Math.max(1e-6, speechRms));

  // Choppiness on a 2.5 ms dB envelope.
  const h25 = Math.max(1, Math.round(sr * 0.0025));
  const m25 = Math.floor(n / h25);
  const eDb = new Float32Array(m25);
  for (let k = 0; k < m25; k++) { let q = 0; for (let i = k * h25; i < (k + 1) * h25; i++) q += pcm[i] * pcm[i]; eDb[k] = 10 * Math.log10(q / h25 + 1e-12); }
  let eMax = -Infinity;
  for (const v of eDb) eMax = Math.max(eMax, v);
  let breaks = 0, dips = 0;
  for (let k = 0; k + 1 < m25; k++) {
    if (eDb[k] >= eMax - 20 && eDb[k + 1] < eMax - 20) {
      let j = k + 1;
      while (j < m25 && eDb[j] > eMax - 45 && eDb[j] < eMax - 20) j++;
      if (j < m25 && eDb[j] <= eMax - 45) breaks++;
    }
  }
  for (let k = 6; k < m25 - 6; k++) {
    if (eDb[k] >= eMax - 35) continue;
    let L = false, R = false;
    for (let j = 1; j <= 6; j++) { if (eDb[k - j] >= eMax - 20) L = true; if (eDb[k + j] >= eMax - 20) R = true; }
    if (L && R) { dips++; k += 6; }
  }

  // F0.
  const [lo, hi] = F0_RANGE[gender];
  const tr = trackF0(pcm, sr, lo, hi);
  const s = f0Stats(tr);
  let oct = 0, prev = 0;
  for (const f of tr.f0) { if (f > 0 && prev > 0 && Math.abs(Math.log2(f / prev)) >= 0.8) oct++; if (f > 0) prev = f; else prev = 0; }

  // HNR + flatness on voiced 40 ms frames (hop 20 ms).
  const fl = 1 << Math.round(Math.log2(sr * 0.04));
  const hnr: number[] = [], flat: number[] = [];
  const minLag = Math.floor(sr / hi), maxLag = Math.ceil(sr / lo);
  for (let a = 0; a + fl + maxLag < n; a += Math.round(sr * 0.02)) {
    const k = Math.min(tr.f0.length - 1, Math.round((a + fl / 2) / tr.hop));
    if (!(tr.f0[k] > 0)) continue;
    const f0 = tr.f0[k];
    const P = Math.round(sr / f0);
    if (P < minLag || P > maxLag) continue;
    let best = 0;
    for (let lag = Math.max(2, Math.floor(P * 0.9)); lag <= Math.ceil(P * 1.1); lag++) {
      let c = 0, e0 = 0, e1 = 0;
      for (let i = 0; i < fl; i++) { const u = pcm[a + i], v = pcm[a + i + lag]; c += u * v; e0 += u * u; e1 += v * v; }
      const r = e0 > 0 && e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
      if (r > best) best = r;
    }
    const r = Math.min(0.999, Math.max(0.001, best));
    hnr.push(10 * Math.log10(r / (1 - r)));
    const frame = new Float32Array(fl);
    for (let i = 0; i < fl; i++) frame[i] = pcm[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fl));
    const p = powerSpectrum(frame);
    const k0 = Math.max(1, Math.round((100 * fl) / sr)), k1 = Math.min(p.length - 1, Math.round((5000 * fl) / sr));
    let lg = 0, ar = 0;
    for (let q = k0; q <= k1; q++) { const v = p[q] + 1e-12; lg += Math.log(v); ar += v; }
    const m = k1 - k0 + 1;
    flat.push(Math.exp(lg / m) / (ar / m));
  }
  flat.sort((a, b) => a - b);
  const r2 = (v: number, k = 2) => Number(v.toFixed(k));
  return {
    sr, ms: Math.round((n / sr) * 1000), peak: r2(peak, 3), clipPct: r2((100 * clip) / n, 3),
    maxJump: r2(maxD / Math.max(1e-9, medD), 1), clicks, gaps, tailDb: r2(tailDb, 1), lastSample: r2(Math.abs(pcm[n - 1] ?? 0), 4),
    meanHz: Math.round(s.meanHz), rangeSt: r2(s.rangeSt), stdSt: r2(s.stdSt), octaveJumps: oct,
    breaksPerS: r2(breaks / (n / sr)), dips,
    hnrDb: r2(hnr.length ? hnr.reduce((a, b) => a + b, 0) / hnr.length : 0), flatness: r2(flat.length ? flat[flat.length >> 1] : 0, 4),
  };
}
