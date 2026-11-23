// Speaker gender from original-audio pitch (§5 SpeakerPitch). Owner: C.
import type { Gender, Line } from '../../shared/types';

/** F0 below this → male. */
export const MALE_MAX_HZ = 165;
/** Fewer voiced frames than this share → unknown. */
export const MIN_VOICED_SHARE = 0.3;
const F0_MIN = 70;
const F0_MAX = 400;
const SILENCE_RMS = 0.01;
const VOICED_CORR = 0.5;
const FRAME_KEEP_S = 180;

/** One analysis frame: media time (s), F0 in Hz (null = unvoiced/silent), RMS level (optional). */
export interface PitchFrame { t: number; f0: number | null; rms?: number }

/** RMS level of a buffer (DC removed). */
export function bufRms(buf: Float32Array): number {
  const n = buf.length;
  if (!n) return 0;
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { sum += buf[i]; sq += buf[i] * buf[i]; }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

// ---------------------------------------------------------------- v1.1 stable speaker tracking

/** Median F0 below this = confidently male. */
export const CONF_MALE_HZ = 155;
/** Median F0 above this = confidently female (unless shouting). */
export const CONF_FEMALE_HZ = 205;
/** Minimum time between two evidence-only voice switches (s). */
export const MIN_SWITCH_S = 6;
/** Loudness percentile (per video) above which a high F0 counts as shouting, not as a female voice. */
export const LOUD_PERCENTILE = 0.8;

/** What one line of original audio tells about its speaker. */
export interface LineEvidence {
  /** Media time of the line start (s). */
  t: number;
  /** Median F0 of voiced frames (Hz), null if none. */
  f0: number | null;
  /** Share of voiced frames 0..1. */
  voicedShare: number;
  /** Median RMS of voiced frames, null if unknown. */
  rms: number | null;
  /** The captions mark a speaker change at this line (">>", "- ", "NAME:"). */
  marker?: boolean;
  /** Caption speaker label gender ([Man], (femme)…): authoritative. */
  hint?: Gender;
}

/**
 * Stable speaker gender with hysteresis. Switches only on: a caption gender label; a speaker-change marker plus confident
 * opposite evidence (on that line or the next confident one); or 2 consecutive confident opposite lines at least 6 s after
 * the last switch. Between 155 and 205 Hz = no evidence. A high F0 that is also among the loudest 20 % of this video's
 * lines is a shouting man as often as a woman: no evidence.
 */
export class SpeakerTracker {
  private cur: Gender = 'unknown';
  private lastSwitch = -Infinity;
  private opposite = 0;
  private markerPending = false;
  private loud: number[] = [];
  /** Number of switches (tests/diagnostics). */
  switches = 0;

  current(): Gender { return this.cur; }

  reset(): void {
    this.cur = 'unknown';
    this.lastSwitch = -Infinity;
    this.opposite = 0;
    this.markerPending = false;
    this.loud = [];
    this.switches = 0;
  }

  /** Confident gender of one line's evidence, or 'unknown'. Also records its loudness. */
  classify(ev: LineEvidence): Gender {
    const rms = ev.rms != null && Number.isFinite(ev.rms) && ev.rms > 0 ? ev.rms : null;
    if (rms != null) {
      this.loud.push(rms);
      if (this.loud.length > 400) this.loud.shift();
    }
    if (ev.f0 == null || !Number.isFinite(ev.f0) || ev.voicedShare < MIN_VOICED_SHARE) return 'unknown';
    if (ev.f0 < CONF_MALE_HZ) return 'male';
    if (ev.f0 <= CONF_FEMALE_HZ) return 'unknown';
    if (rms != null && this.loud.length >= 5) {
      const sorted = [...this.loud].sort((a, b) => a - b);
      const thr = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * LOUD_PERCENTILE))];
      if (rms > thr) return 'unknown'; // shouting guard
    }
    return 'female';
  }

  /** Feed the evidence of a line whose original audio has played. Returns the speaker gender to use from now on. */
  observe(ev: LineEvidence): Gender {
    if (ev.marker) { this.markerPending = true; this.opposite = 0; }
    if (ev.hint && ev.hint !== 'unknown') {
      this.classify(ev); // keep loudness stats
      this.markerPending = false;
      this.opposite = 0;
      if (ev.hint !== this.cur) this.switchTo(ev.hint, ev.t);
      return this.cur;
    }
    const g = this.classify(ev);
    if (g === 'unknown') {
      this.opposite = 0; // "consecutive" means adjacent lines: an unclear line breaks the run
      return this.cur;
    }
    if (this.cur === 'unknown') {
      this.markerPending = false;
      this.switchTo(g, ev.t);
      return this.cur;
    }
    if (g === this.cur) {
      this.opposite = 0;
      this.markerPending = false;
      return this.cur;
    }
    if (this.markerPending) {
      this.markerPending = false;
      this.switchTo(g, ev.t);
      return this.cur;
    }
    this.opposite++;
    if (this.opposite >= 2 && ev.t - this.lastSwitch >= MIN_SWITCH_S) this.switchTo(g, ev.t);
    return this.cur;
  }

  private switchTo(g: Gender, t: number): void {
    if (this.cur !== 'unknown' && g !== this.cur) this.switches++;
    this.cur = g;
    this.lastSwitch = t;
    this.opposite = 0;
  }
}

/** Caption speaker-change marker of a line: `Line.newSpeaker`, or a ">>" / dialogue-dash prefix still in the text. */
export function speakerMarker(line: Line): boolean {
  if (line.newSpeaker) return true;
  return /^\s*(?:>>|[-–—]\s)/.test(line.source ?? '') || /^\s*(?:>>|[-–—]\s)/.test(line.text);
}

/**
 * Autocorrelation F0 estimate of a mono buffer. Returns Hz, or null when silent or unvoiced.
 * Picks the shortest lag whose normalised correlation is within 10 % of the best (avoids octave-down errors).
 */
export function estimateF0(buf: Float32Array, sampleRate: number): number | null {
  if (sampleRate >= 32000 && buf.length >= 256) {
    // Halve the rate (pair average) to cut the O(n·lags) cost; F0 ≤ 400 Hz is far below Nyquist.
    const half = new Float32Array(buf.length >> 1);
    for (let i = 0; i < half.length; i++) half[i] = (buf[2 * i] + buf[2 * i + 1]) / 2;
    return estimateF0(half, sampleRate / 2);
  }
  const n = buf.length;
  if (n < 64 || !(sampleRate > 0)) return null;
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { sum += buf[i]; sq += buf[i] * buf[i]; }
  const mean = sum / n;
  const rms = Math.sqrt(Math.max(0, sq / n - mean * mean));
  if (!(rms >= SILENCE_RMS)) return null;
  const minLag = Math.max(2, Math.floor(sampleRate / F0_MAX));
  const maxLag = Math.min(Math.floor(sampleRate / F0_MIN), Math.floor(n / 2));
  if (maxLag <= minLag + 2) return null;
  const win = n - maxLag;
  const corr = new Float32Array(maxLag + 2);
  let e0 = 0;
  for (let i = 0; i < win; i++) { const a = buf[i] - mean; e0 += a * a; }
  let best = -1;
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let c = 0, e1 = 0;
    for (let i = 0; i < win; i++) {
      const b = buf[i + lag] - mean;
      c += (buf[i] - mean) * b;
      e1 += b * b;
    }
    const r = e0 > 0 && e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
    corr[lag] = r;
    if (lag >= minLag && lag <= maxLag && r > best) best = r;
  }
  if (best < VOICED_CORR) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const r = corr[lag];
    if (r >= best * 0.9 && r >= corr[lag - 1] && r >= corr[lag + 1]) {
      // Parabolic interpolation around the peak.
      const a = corr[lag - 1], b = r, c = corr[lag + 1];
      const den = a - 2 * b + c;
      const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
      const period = lag + (Math.abs(shift) < 1 ? shift : 0);
      return sampleRate / period;
    }
  }
  return null;
}

/** Gender from analysis frames: < 30 % voiced → unknown; median F0 < 165 Hz → male, else female. */
export function classifyFrames(frames: readonly PitchFrame[]): Gender {
  if (frames.length === 0) return 'unknown';
  const f0s = frames.map((f) => f.f0).filter((v): v is number => v != null && Number.isFinite(v));
  if (f0s.length / frames.length < MIN_VOICED_SHARE || f0s.length === 0) return 'unknown';
  f0s.sort((a, b) => a - b);
  const mid = f0s.length >> 1;
  const median = f0s.length % 2 ? f0s[mid] : (f0s[mid - 1] + f0s[mid]) / 2;
  return median < MALE_MAX_HZ ? 'male' : 'female';
}

const MALE_HINT = /\[(?:man|male|homme|hombre|erkek|رجل)\]|\((?:man|male|homme|hombre|erkek|رجل)\)/i;
const FEMALE_HINT = /\[(?:woman|female|femme|mujer|kadın|kadin|امرأة|إمرأة)\]|\((?:woman|female|femme|mujer|kadın|kadin|امرأة|إمرأة)\)/i;

/** Caption-label gender: `Line.gender` if set, else `[Man]` / `(femme)`-style hints in text/source. */
export function captionGender(line: Line): Gender {
  if (line.gender && line.gender !== 'unknown') return line.gender;
  const txt = `${line.source ?? ''} ${line.text}`;
  if (MALE_HINT.test(txt)) return 'male';
  if (FEMALE_HINT.test(txt)) return 'female';
  return 'unknown';
}

interface Graph {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
  gain: GainNode;
}

/** A MediaElementSource can be created once per element, ever: reuse the graph across sessions. */
const graphs = new WeakMap<HTMLMediaElement, Graph>();

export interface SpeakerPitchOptions {
  /** AudioContext factory (tests); default `new AudioContext()`. */
  createContext?: () => AudioContext;
  /** Sampling period (ms), default 50. */
  intervalMs?: number;
}

/** WebAudio graph on the <video>: autocorrelation F0 every 50 ms; median F0 per line → gender (< 165 Hz male). Also owns ducking gain when the graph exists. */
export class SpeakerPitch {
  private readonly video: HTMLVideoElement;
  private readonly opts: SpeakerPitchOptions;
  private graph: Graph | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frames: PitchFrame[] = [];
  private buf: Float32Array<ArrayBuffer> | null = null;
  private failed = false;
  private stopped = false;

  constructor(video: HTMLVideoElement, opts: SpeakerPitchOptions = {}) {
    this.video = video;
    this.opts = opts;
  }

  /** Build the graph and start sampling. Returns false if WebAudio failed or is not running yet (then genderFor → 'unknown'). Call from a user gesture. */
  start(): boolean {
    void this.startAsync();
    return !!this.graph && !!this.timer;
  }

  /** Like start(), but waits (≤ 1 s) for a suspended AudioContext to resume before routing the video through it. */
  startAsync(): Promise<boolean> {
    if (this.pending) return this.pending;
    this.pending = this.doStart().finally(() => { this.pending = null; });
    return this.pending;
  }

  private pending: Promise<boolean> | null = null;

  private async doStart(): Promise<boolean> {
    if (this.failed) return false;
    try {
      let g = graphs.get(this.video) ?? null;
      if (!g) {
        const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
        const ctx = this.opts.createContext ? this.opts.createContext() : Ctor ? new Ctor() : null;
        if (!ctx) throw new Error('no AudioContext');
        // Never route the video through a suspended context: that would mute it.
        if (ctx.state !== 'running') {
          await Promise.race([Promise.resolve(ctx.resume?.()).catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
          if ((ctx.state as string) !== 'running') {
            void Promise.resolve(ctx.close?.()).catch(() => {});
            throw new Error('AudioContext not running (no user gesture?)');
          }
        }
        g = graphs.get(this.video) ?? null; // another start may have won the race
        if (!g) {
          const source = ctx.createMediaElementSource(this.video);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          const gain = ctx.createGain();
          source.connect(gain);
          gain.connect(ctx.destination);
          source.connect(analyser); // analyser taps the original before ducking
          g = { ctx, source, analyser, gain };
          graphs.set(this.video, g);
        } else {
          void Promise.resolve(ctx.close?.()).catch(() => {});
        }
      } else if (g.ctx.state === 'suspended') {
        void g.ctx.resume().catch(() => {});
      }
      if (this.stopped) return false;
      this.graph = g;
      this.buf = new Float32Array(g.analyser.fftSize);
      if (!this.timer) this.timer = setInterval(() => this.sample(), this.opts.intervalMs ?? 50);
      return true;
    } catch (e) {
      this.failed = true;
      this.graph = graphs.get(this.video) ?? null; // a half-built graph still owns the audio
      console.warn('[autodub] pitch analysis unavailable', e instanceof Error ? e.message : e);
      return false;
    }
  }

  /** True when the WebAudio graph exists (ducking should use setGain). */
  hasGraph(): boolean { return !!this.graph; }

  /** Record one frame (sampling loop; public for tests). */
  addFrame(t: number, f0: number | null, rms?: number): void {
    this.frames.push(rms != null ? { t, f0, rms } : { t, f0 });
    const cutoff = t - FRAME_KEEP_S;
    if (this.frames.length > 4000 || (this.frames[0] && this.frames[0].t < cutoff)) {
      this.frames = this.frames.filter((f) => f.t >= cutoff && f.t <= t + 1);
    }
  }

  /** Gender for a line from F0 over [start,end] and caption hints; 'unknown' if < 30 % voiced. */
  genderFor(line: Line): Gender {
    const hint = captionGender(line);
    if (hint !== 'unknown') return hint;
    try {
      return classifyFrames(this.frames.filter((f) => f.t >= line.start && f.t <= line.end));
    } catch {
      return 'unknown';
    }
  }

  /** Evidence (median F0, voiced share, median RMS) of the original audio over [start, end]. */
  evidence(line: Line): LineEvidence {
    const fr = this.frames.filter((f) => f.t >= line.start && f.t <= line.end);
    const voiced = fr.filter((f) => f.f0 != null && Number.isFinite(f.f0));
    const med = (a: number[]) => {
      if (!a.length) return null;
      a.sort((x, y) => x - y);
      const m = a.length >> 1;
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    return {
      t: line.start,
      f0: med(voiced.map((f) => f.f0 as number)),
      voicedShare: fr.length ? voiced.length / fr.length : 0,
      rms: med(voiced.map((f) => f.rms).filter((v): v is number => v != null)),
      marker: speakerMarker(line),
      hint: captionGender(line),
    };
  }

  /**
   * Update the speaker guess from a line whose original audio has played (stable: see SpeakerTracker).
   * `marker` overrides the line's own speaker-change marker.
   */
  observe(line: Line, marker?: boolean): Gender {
    let ev: LineEvidence;
    try { ev = this.evidence(line); } catch { return this.tracker.current(); }
    if (marker != null) ev.marker = marker;
    return this.tracker.observe(ev);
  }

  /** Predicted gender of the next line (= current stable speaker; 'unknown' before the first). */
  predicted(): Gender { return this.tracker.current(); }

  /** The stable speaker tracker (diagnostics/tests). */
  readonly tracker = new SpeakerTracker();

  /** Original-audio gain 0..1 (ducking) when the graph exists. */
  setGain(v: number): void {
    const g = this.graph;
    if (!g) return;
    const val = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    try {
      const p = g.gain.gain;
      p.cancelScheduledValues?.(g.ctx.currentTime);
      p.setValueAtTime(val, g.ctx.currentTime);
    } catch {
      try { g.gain.gain.value = val; } catch { /* ignore */ }
    }
  }

  /** Stop sampling; keep audio routed (a MediaElementSource cannot be detached). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setGain(1);
    this.frames = [];
    this.tracker.reset();
  }

  private sample(): void {
    const g = this.graph;
    if (!g || !this.buf) return;
    const v = this.video;
    if (v.paused || v.seeking) return;
    try {
      if (g.ctx.state === 'suspended') void g.ctx.resume().catch(() => {});
      g.analyser.getFloatTimeDomainData(this.buf);
      this.addFrame(v.currentTime, estimateF0(this.buf, g.ctx.sampleRate), bufRms(this.buf));
    } catch {
      /* keep going; genderFor falls back to unknown */
    }
  }
}
