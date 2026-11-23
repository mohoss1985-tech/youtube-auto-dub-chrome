// Fake-clock simulation of a fast-talker track for pacing metrics (S, v1.1).
import type { Line, Plan } from '../../../src/shared/types';
import type { PlayEnd, PlayHandle } from '../../../src/content/voice/engine';

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Natural ms at the fr prior (CPS 14, +120 ms per punctuation mark) for `text` — mirrors fit.estimateMs. */
const priorMs = (text: string) => (text.length / 14) * 1000 + (text.match(/[,.;:!?]/g)?.length ?? 0) * 120;

/**
 * Fast talker (MrBeast / NBA commentary): lines 1.2–4 s, mostly tiny gaps (0.05–0.3 s), sometimes a breath (0.7–1.3 s).
 * Speech density ≈ 90 %. French text is `longer` × the slot at the prior CPS (default 20 % longer).
 */
export function fastTalkerTrack(seconds = 600, seed = 11, longer = 1.2): Line[] {
  const r = rng(seed);
  const lines: Line[] = [];
  let t = 1;
  let i = 0;
  while (t < seconds) {
    const dur = 1.2 + r() * 2.8;
    const targetMs = dur * 1000 * longer - 120; // one '.' at the end
    const chars = Math.max(4, Math.round((targetMs / 1000) * 14));
    let text = '';
    while (text.length < chars - 1) text += 'mots ';
    text = text.slice(0, chars - 1).trim() + '.';
    lines.push({ id: `l${i++}`, start: +t.toFixed(3), end: +(t + dur).toFixed(3), text });
    t += dur + (r() < 0.82 ? 0.05 + r() * 0.25 : 0.7 + r() * 0.6);
  }
  return lines;
}

export interface SimClock { t: number; now(): number; playbackRate(): number; paused(): boolean }
export function simClock(): SimClock {
  return { t: 0, now() { return this.t; }, playbackRate: () => 1, paused: () => false };
}

export interface SimRec { plan: Plan; call: number; start: number; end: number; state: 'playing' | PlayEnd; resolve: (r: PlayEnd) => void; natural: number }

/**
 * Engine model: duration = natural / rate, natural = prior × `slow` (voice slower than the prior when > 1).
 * Start latency `latencyS` for a fresh utterance (Web Speech ≈ 0.1–0.2 s); a queued line (canQueue) starts with no gap.
 */
export class SimSpeaker {
  recs: SimRec[] = [];
  canQueue?: () => boolean;
  constructor(private clock: SimClock, private o: { slow?: number; latencyS?: number; queue?: boolean; dropLateS?: number } = {}) {
    if (o.queue) this.canQueue = () => true;
  }
  speak(plan: Plan): PlayHandle {
    let resolve!: (r: PlayEnd) => void;
    const done = new Promise<PlayEnd>((r) => { resolve = r; });
    const natural = priorMs(plan.line.text) * (this.o.slow ?? 1);
    if (this.o.dropLateS != null && this.clock.t - plan.startAt > this.o.dropLateS) {
      // v1.0 DubSession.speak dropped a line that was more than 0.3 s late when it reached the engine.
      resolve('stopped');
      return { done, stop() {}, pause() {}, resume() {} };
    }
    const playing = this.recs.filter((x) => x.state === 'playing');
    const lastEnd = playing.length ? Math.max(...playing.map((x) => x.end)) : -Infinity;
    const start = Math.max(this.clock.t + (this.o.latencyS ?? 0.12), lastEnd);
    const rec: SimRec = { plan, call: this.clock.t, start, end: start + natural / plan.rate / 1000, state: 'playing', resolve, natural };
    this.recs.push(rec);
    return { done, stop: () => { if (rec.state === 'playing') { rec.state = 'stopped'; rec.end = Math.min(rec.end, this.clock.t); resolve('stopped'); } }, pause() {}, resume() {} };
  }
  stopAll() { for (const r of this.recs) if (r.state === 'playing') { r.state = 'stopped'; r.end = Math.min(r.end, this.clock.t); r.resolve('stopped'); } }
  advance(): SimRec[] {
    const out: SimRec[] = [];
    for (const r of this.recs) if (r.state === 'playing' && this.clock.t >= r.end) { r.state = 'ended'; r.resolve('ended'); out.push(r); }
    return out;
  }
}

export interface PaceMetrics {
  spokenShare: number;
  stopped: number;
  /** Longest silence overlapping caption speech (s). */
  maxSilenceS: number;
  /** Longest raw gap between two spoken lines, pauses included (s). */
  maxGapS: number;
  maxRate: number;
  maxRateStep: number;
  maxLagS: number;
  meanLagS: number;
  silencesOver1s: number;
}

/** Metrics over spoken lines (real start/end), against the caption timeline. */
export function metrics(lines: readonly Line[], recs: readonly SimRec[]): PaceMetrics {
  const spoken = recs.slice().sort((a, b) => a.start - b.start);
  let maxGap = 0, maxSil = 0, silOver = 0, maxRate = 0, maxStep = 0, maxLag = 0, sumLag = 0;
  for (let i = 0; i < spoken.length; i++) {
    const r = spoken[i];
    maxRate = Math.max(maxRate, r.plan.rate);
    const lag = r.start - r.plan.line.start;
    maxLag = Math.max(maxLag, lag);
    sumLag += Math.max(0, lag);
    if (i > 0) {
      const p = spoken[i - 1];
      maxStep = Math.max(maxStep, Math.abs(r.plan.rate - p.plan.rate));
      const a = p.end, b = r.start;
      // Internal silence: time the voice is quiet while the captions have speech (pauses in the original don't count).
      if (b - a > 0) {
        let sil = 0;
        for (const l of lines) if (l.start < b && l.end > a) sil += Math.min(b, l.end) - Math.max(a, l.start);
        maxSil = Math.max(maxSil, sil);
        if (sil > 1) silOver++;
        maxGap = Math.max(maxGap, b - a);
      }
    }
  }
  return {
    spokenShare: new Set(spoken.map((r) => r.plan.line.id)).size / lines.length,
    stopped: spoken.filter((r) => r.state === 'stopped').length,
    maxSilenceS: maxSil,
    maxGapS: maxGap,
    maxRate,
    maxRateStep: maxStep,
    maxLagS: maxLag,
    meanLagS: spoken.length ? sumLag / spoken.length : 0,
    silencesOver1s: silOver,
  };
}

const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

/** Drive a scheduler-like object at 50 ms ticks until `until` s. `onEnded` sees each line that ended (calibration). */
export async function drive(sch: { start(): void; tick(): void; stop(): void }, clock: SimClock, spk: SimSpeaker, until: number, onEnded?: (r: SimRec) => void) {
  sch.start();
  for (clock.t = 0; clock.t <= until; clock.t = +(clock.t + 0.05).toFixed(2)) {
    const ended = spk.advance();
    await flush();
    for (const r of ended) onEnded?.(r);
    sch.tick();
  }
  sch.stop();
}
