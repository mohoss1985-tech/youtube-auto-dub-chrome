// Media-time-driven line scheduler (§5). Owner: C.
import type { Lang, Line, Plan } from '../../shared/types';
import type { PlayEnd, PlayHandle } from '../voice/engine';
import { estimateMs, fit, planTrack } from './fit';
import type { PacedPlan } from './fit';

/** Media clock (seconds). Real: wraps <video>; tests: fake clock. */
export interface Clock {
  /** Current media time in seconds. */
  now(): number;
  /** Video playbackRate. */
  playbackRate(): number;
  paused(): boolean;
}

/** Plays a planned line. DubSession adapts a TtsEngine (+ prepared cache) to this. `plan.rate` already includes video playbackRate. */
export interface Speaker {
  speak(plan: Plan): PlayHandle;
  stopAll(): void;
  /**
   * True when speak() may be called while a line is still playing and the engine will start the new line right
   * after it, gaplessly (Web Speech queue). Continuous mode then pre-queues the next line near the end of the current one.
   */
  canQueue?(): boolean;
}

export interface SchedulerOptions {
  lang?: Lang;
  /** Start lead in ms (80 WebSpeech / 30 audio). */
  leadMs?: number;
  /** Skip a not-started line this late (default 300 ms). */
  lateSkipMs?: number;
  /**
   * Continuous mode (> 0): never cut a line mid-sentence. The whole track is planned ahead (`planTrack`: clusters,
   * one smooth pace per cluster); lines chain back to back; a gentle lag controller adds ≤ 0.12 rate.
   * Lines are skipped only when the lag exceeds this value (then resync at a sentence boundary).
   * 0 = strict mode (cut overruns, 300 ms late skip). The session uses 6000.
   */
  maxLagMs?: number;
  /** @deprecated v1.0 per-line catch-up multiplier; unused since v1.1 (lag control is proportional). */
  maxCatchUp?: number;
  /** Continuous mode: plan the whole track (default: planTrack with the prior CPS, one voice). */
  planTrack?: (lines: readonly Line[]) => PacedPlan[];
  /** Continuous mode: max |rate change| between consecutive lines of the same voice (default 0.08). */
  maxRateStep?: number;
  /** Continuous mode: start the next line right away when the voice frees up and it is due within this (s, default 0.7). */
  fillGapS?: number;
  /** Tick period in ms (default 50). */
  tickMs?: number;
  /** Build a plan for line i (default: fit(lines[i], lines[i+1], lang)). */
  plan?: (line: Line, next: Line | undefined) => Plan;
  onLineStart?: (plan: Plan, lateMs: number) => void;
  onLineEnd?: (plan: Plan, overflowMs: number) => void;
  /** Ducking hook: on=true ~150 ms before a line, false 250 ms after speech ends (held if next line within 400 ms). */
  onDuck?: (on: boolean) => void;
  /** Ramp-down lead before a line (default 150 ms). */
  duckLeadMs?: number;
  /** Restore delay after speech ends (default 250 ms). */
  duckRestoreMs?: number;
  /** Keep ducked if the next line starts within this (default 400 ms). */
  duckHoldMs?: number;
  /** Max effective speech rate (plan.rate × playbackRate) the engines accept (default 2). */
  maxTotalRate?: number;
  /** Video element: drives extra ticks via requestVideoFrameCallback when available. */
  video?: HTMLVideoElement | null;
  /** Called on every tick with media time (prefetch pump etc.). */
  onTick?: (t: number) => void;
}

interface Current {
  plan: Plan;
  /** Estimated media seconds of speech at `rate` (continuous mode). */
  durS?: number;
  index: number;
  handle: PlayHandle;
  /** Media time when speech started. */
  t0: number;
  /** Speech rate passed to the speaker (plan.rate × video rate). */
  rate: number;
  ended: boolean;
}

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

/**
 * Drives speech from clock time. Strict mode: lag never carries over (late lines skipped, overruns cut).
 * Continuous mode (maxLagMs > 0): whole-track pace plan, back-to-back lines, gentle lag control, no mid-sentence cuts.
 */
export class Scheduler {
  private lines: Line[];
  private readonly clock: Clock;
  private readonly speaker: Speaker;
  private readonly o: Required<Pick<SchedulerOptions, 'leadMs' | 'lateSkipMs' | 'tickMs' | 'duckLeadMs' | 'duckRestoreMs' | 'duckHoldMs' | 'maxTotalRate' | 'maxLagMs' | 'maxCatchUp'>> & SchedulerOptions;
  private cursor = 0;
  private cur: Current | null = null;
  private running = false;
  private pausedFlag = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rvfcHandle: number | null = null;
  private ducked = false;
  /** Media time when the last speech ended (for duck restore). */
  private speechEndT: number | null = null;
  private lastT: number | null = null;
  private seq = 0;
  /** startAt of the last line started (setLines must not replay it). */
  private lastStartedAt: number | null = null;
  /** Continuous mode: plans for `lines` (null = recompute). */
  private plans: PacedPlan[] | null = null;
  /** Continuous mode: line already handed to the engine queue, waiting for the current one to end. */
  private queued: Current | null = null;
  /** Lag controller output (EMA, added to the planned rate). */
  private extra = 0;
  /** Previous spoken line (rate limiter): media rate (before playbackRate) and voice factor. */
  private prev: { rate: number; factor: number; voice?: string } | null = null;

  constructor(lines: Line[], clock: Clock, speaker: Speaker, opts?: SchedulerOptions) {
    this.lines = [...lines].sort((a, b) => a.start - b.start);
    this.clock = clock;
    this.speaker = speaker;
    const given = Object.fromEntries(Object.entries(opts ?? {}).filter(([, v]) => v !== undefined)) as SchedulerOptions;
    this.o = { ...DEFAULTS, ...given };
  }

  /** Start ticking (50 ms + requestVideoFrameCallback when available). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.seek(this.clock.now());
    this.timer = setInterval(() => this.tick(), this.o.tickMs);
    this.armRvfc();
    this.tick();
  }

  /** Stop ticking and all speech. */
  stop(): void {
    this.running = false;
    this.dropQueued();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const v = this.o.video as RvfcVideo | null | undefined;
    if (this.rvfcHandle != null && v?.cancelVideoFrameCallback) {
      try { v.cancelVideoFrameCallback(this.rvfcHandle); } catch { /* ignore */ }
    }
    this.rvfcHandle = null;
    this.cutCurrent();
    try { this.speaker.stopAll(); } catch { /* ignore */ }
    this.setDuck(false);
  }

  isRunning(): boolean { return this.running; }

  /** Line being spoken now, or null. */
  current(): Plan | null {
    return this.cur && !this.cur.ended ? this.cur.plan : null;
  }

  /** Index of the next line to start. */
  cursorIndex(): number { return this.cursor; }

  getLines(): readonly Line[] { return this.lines; }

  /** One scheduling step (public for fake-clock tests). */
  tick(): void {
    if (!this.running || this.pausedFlag || this.clock.paused()) return;
    const t = this.clock.now();
    if (!Number.isFinite(t)) return;
    // Media time jumped backwards without a seek event (loop, missed event) → resync.
    if (this.lastT != null && t < this.lastT - 0.5) {
      this.seek(t);
    }
    this.lastT = t;
    this.o.onTick?.(t);

    const lead = this.o.leadMs / 1000;
    const late = this.o.lateSkipMs / 1000;

    const continuous = this.o.maxLagMs > 0;
    const speaking = !!this.cur && !this.cur.ended;

    if (continuous) {
      // Safety only: a line stuck far past its slot (engine never ended) is cut.
      if (speaking && t >= this.cur!.t0 + this.cur!.plan.maxMs / 1000 + this.o.maxLagMs / 1000 + 4) this.cutCurrent();
    } else if (speaking && t >= this.cur!.t0 + this.cur!.plan.maxMs / 1000) {
      // Strict: cut the playing line at its hard boundary.
      this.cutCurrent();
    }

    const busy = !!this.cur && !this.cur.ended;
    if (continuous) {
      this.tickContinuous(t, busy, lead);
    } else {
      // Strict: skip lines that are too late to start.
      while (this.cursor < this.lines.length && t > this.lines[this.cursor].start + late) this.cursor++;
      const next = this.lines[this.cursor];
      if (next && t >= next.start - lead) {
        this.startLine(this.cursor, t);
      } else if (next && !this.ducked && t >= next.start - lead - this.o.duckLeadMs / 1000) {
        this.setDuck(true);
      }
    }

    // Restore the original audio after speech, unless the next line is close.
    if (this.ducked && (!this.cur || this.cur.ended)) {
      if (this.speechEndT == null) this.speechEndT = t;
      const endT = this.speechEndT;
      const upcoming = this.lines[this.cursor];
      const nearNext = upcoming && upcoming.start - lead - endT <= this.o.duckHoldMs / 1000 && upcoming.start - lead - t > -0.001;
      const leadingIn = upcoming && t >= upcoming.start - lead - this.o.duckLeadMs / 1000;
      if (t >= endT + this.o.duckRestoreMs / 1000 && !nearNext && !leadingIn) this.setDuck(false);
    }
  }

  /** Stop speech and binary-search the cursor to media time `t` (seconds). */
  seek(t: number): void {
    this.cutCurrent();
    this.dropQueued();
    this.prev = null;
    this.extra = 0;
    try { this.speaker.stopAll(); } catch { /* ignore */ }
    this.cursor = lowerBound(this.lines, t - this.o.lateSkipMs / 1000);
    this.lastStartedAt = null;
    this.lastT = t;
    this.speechEndT = null;
    this.setDuck(false);
  }

  pause(): void {
    this.pausedFlag = true;
    if (this.cur && !this.cur.ended) {
      try { this.cur.handle.pause(); } catch { /* ignore */ }
    }
    if (this.queued && !this.queued.ended) {
      try { this.queued.handle.pause(); } catch { /* ignore */ }
    }
  }

  resume(): void {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    if (this.cur && !this.cur.ended) {
      try { this.cur.handle.resume(); } catch { /* ignore */ }
    }
    if (this.queued && !this.queued.ended) {
      try { this.queued.handle.resume(); } catch { /* ignore */ }
    }
    this.lastT = this.clock.now();
    this.tick();
  }

  isPaused(): boolean { return this.pausedFlag; }

  /** Video playbackRate changed: re-rate the playing line. */
  rateChanged(): void {
    if (!this.cur || this.cur.ended) return;
    const vr = safeRate(this.clock.playbackRate());
    const r = Math.min(this.cur.plan.rate * vr, this.o.maxTotalRate);
    this.cur.rate = r;
    try { this.cur.handle.setRate?.(r); } catch { /* ignore */ }
  }

  /** Replace lines (e.g. after translation of later batches); keeps cursor by time. */
  setLines(lines: Line[]): void {
    this.lines = [...lines].sort((a, b) => a.start - b.start);
    this.plans = null;
    // Next line = first one not yet due-and-missed, and after the last line already started (never replay).
    let c = lowerBound(this.lines, this.clock.now() - this.o.lateSkipMs / 1000);
    if (this.lastStartedAt != null) c = Math.max(c, upperBound(this.lines, this.lastStartedAt));
    if (this.queued && this.lastStartedAt != null) c = Math.max(c, upperBound(this.lines, this.queued.plan.line.start));
    this.cursor = c;
  }

  /** Continuous mode: recompute the track plan (voice calibration or speaker voice changed). Lines already playing keep their rate. */
  replan(): void { this.plans = null; }

  /** Continuous mode: plan for line i (null in strict mode). */
  planAt(i: number): PacedPlan | null {
    if (!(this.o.maxLagMs > 0) || this.o.plan) return null;
    if (!this.plans || this.plans.length !== this.lines.length) {
      const lang = this.o.lang ?? 'en';
      this.plans = this.o.planTrack ? this.o.planTrack(this.lines) : planTrack(this.lines, (l) => ({ u: estimateMs(l.text, lang), f: 1 }));
      if (this.plans.length !== this.lines.length) this.plans = planTrack(this.lines, (l) => ({ u: estimateMs(l.text, lang), f: 1 }));
    }
    return this.plans[i] ?? null;
  }

  // ---------------- internals ----------------

  /** Continuous mode step: chain lines, pre-queue, early starts, skip only beyond maxLag (resync at a sentence boundary). */
  private tickContinuous(t: number, busy: boolean, lead: number): void {
    const skipS = this.o.maxLagMs / 1000;
    const fill = this.o.fillGapS ?? 0.7;
    if (!busy) {
      // Promote a pre-queued line whose predecessor ended (normally done in onDone).
      if (this.queued) this.promote(t);
      if (this.cur && !this.cur.ended) return;
      const nx = this.lines[this.cursor];
      if (nx && t > nx.start + skipS) this.resync(t);
      const next = this.lines[this.cursor];
      if (!next) return;
      const plan = this.planAt(this.cursor);
      const startAt = plan ? plan.startAt : next.start;
      const justFreed = this.speechEndT != null && t - this.speechEndT <= 0.25;
      if (t >= startAt - lead || (justFreed && t >= next.start - fill)) {
        this.startLine(this.cursor, t);
      } else if (!this.ducked && t >= startAt - lead - this.o.duckLeadMs / 1000) {
        this.setDuck(true);
      }
      return;
    }
    // Busy: pre-queue the next line near the end of the current one so the engine chains them with no gap.
    if (this.queued || !this.speaker.canQueue?.()) return;
    const cur = this.cur!;
    const next = this.lines[this.cursor];
    if (!next || cur.durS == null) return;
    const estEnd = cur.t0 + cur.durS;
    if (t < estEnd - 0.3) return;
    if (next.start - fill > estEnd) return; // a real pause follows: start it on time instead
    if (estEnd > next.start + skipS) return; // would be skipped anyway
    this.startLine(this.cursor, t, Math.max(t, estEnd));
  }

  /**
   * Lag > maxLag: drop the backlog and continue with a sentence that started at most 1.5 s ago (or starts within 1 s),
   * preferring one that begins a sentence. The rate limiter keeps its state, so the pace stays smooth across the jump.
   */
  private resync(t: number): void {
    const j0 = lowerBound(this.lines, t - 1.5);
    let j = j0;
    for (let k = j0; k < Math.min(this.lines.length, j0 + 4) && this.lines[k].start <= t + 1; k++) {
      const prevText = this.lines[k - 1]?.text ?? '.';
      if (/[.!?…。؟]["'»”)\]]*\s*$/.test(prevText)) { j = k; break; }
    }
    this.cursor = Math.max(this.cursor, j);
  }

  /** Rate for a continuous-mode line starting at media time `at`: plan + smoothed lag control, capped, step-limited. */
  private continuousRate(plan: PacedPlan, at: number): number {
    const lag = at - plan.line.start;
    const target = Math.min(0.12, Math.max(0, lag / 8));
    this.extra += 0.35 * (target - this.extra);
    let r = Math.min(plan.cap, plan.rate + this.extra);
    const step = this.o.maxRateStep ?? 0.08;
    const p = this.prev;
    if (p) {
      if (p.voice === plan.voice) {
        r = Math.min(p.rate + step, Math.max(p.rate - step, r));
      } else {
        // Different voice: keep the perceived pace (rate × voice speed) continuous instead of the raw rate.
        const q = r * plan.factor;
        const qp = p.rate * p.factor;
        r = Math.min(qp + step, Math.max(qp - step, q)) / plan.factor;
      }
    }
    r = Math.max(0.5, Math.min(plan.cap, r));
    this.prev = { rate: r, factor: plan.factor, voice: plan.voice };
    return r;
  }

  private promote(t: number): void {
    const q = this.queued;
    this.queued = null;
    if (!q || q.ended) return;
    q.t0 = t;
    this.cur = q;
    this.speechEndT = null;
    this.o.onLineStart?.({ ...q.plan, rate: q.rate }, (t - q.plan.startAt) * 1000);
  }

  private dropQueued(): void {
    const q = this.queued;
    this.queued = null;
    if (!q || q.ended) return;
    q.ended = true;
    try { q.handle.stop(); } catch { /* ignore */ }
  }

  private startLine(i: number, t: number, queueAt?: number): void {
    const line = this.lines[i];
    this.cursor = i + 1;
    this.lastStartedAt = line.start;
    const queue = queueAt != null;
    if (!queue && this.cur && !this.cur.ended) this.cutCurrent(); // strict: previous overran → cut
    const paced = this.planAt(i);
    const plan: Plan = paced ?? (this.o.plan ?? ((l, n) => fit(l, n, this.o.lang ?? 'en')))(line, this.lines[i + 1]);
    const vr = safeRate(this.clock.playbackRate());
    let rate: number;
    if (paced) {
      rate = this.continuousRate(paced, queueAt ?? t) * vr;
      if (rate / this.o.maxTotalRate > 1.5) return; // video far too fast for any voice
      rate = Math.min(rate, this.o.maxTotalRate);
    } else {
      const wanted = plan.rate * vr;
      // Video sped up so much the voice cannot keep up: skip lines that would lose more than a third.
      if (wanted / this.o.maxTotalRate > 1.5) return;
      rate = Math.min(wanted, this.o.maxTotalRate);
      // Legacy continuous mode with a custom per-line plan: proportional catch-up.
      const lag = t - line.start;
      if (this.o.maxLagMs > 0 && lag > 0.15) rate = Math.min(rate * (1 + Math.min(0.12, lag / 8)), this.o.maxTotalRate);
    }
    if (!queue) this.setDuck(true);
    let handle: PlayHandle;
    try {
      handle = this.speaker.speak({ ...plan, rate });
    } catch {
      if (!queue) this.speechEndT = t;
      return;
    }
    // Media seconds of speech: natural ms / effective rate, × video rate.
    const durS = paced ? ((paced.estMs * paced.rate) / rate) * vr / 1000 : undefined;
    const cur: Current = { plan, index: i, handle, t0: queueAt ?? t, rate, ended: false, durS };
    const id = ++this.seq;
    if (queue) {
      this.queued = cur;
    } else {
      this.cur = cur;
      this.speechEndT = null;
      this.o.onLineStart?.({ ...plan, rate }, (t - plan.startAt) * 1000);
    }
    Promise.resolve(handle.done).then(
      (r: PlayEnd) => this.onDone(cur, id, r),
      () => this.onDone(cur, id, 'error'),
    );
  }

  private onDone(cur: Current, _id: number, _r: PlayEnd): void {
    if (cur.ended) return;
    if (this.queued === cur) {
      // Queued line finished before its predecessor was seen to end (engine skipped it): just drop it.
      this.queued = null;
      cur.ended = true;
      return;
    }
    this.finish(cur);
    if (this.cur === cur && this.queued && this.running) {
      const t = this.clock.now();
      this.promote(Number.isFinite(t) ? t : cur.t0);
    }
  }

  /** Mark a line finished and report overflow past the line's own end (media ms). */
  private finish(cur: Current): void {
    cur.ended = true;
    const t = this.clock.now();
    if (this.cur === cur) this.speechEndT = Number.isFinite(t) ? t : null;
    const overflowMs = Math.max(0, (t - cur.plan.line.end) * 1000);
    this.o.onLineEnd?.(cur.plan, Number.isFinite(overflowMs) ? overflowMs : 0);
  }

  private cutCurrent(): void {
    const cur = this.cur;
    if (!cur || cur.ended) return;
    try { cur.handle.stop(); } catch { /* ignore */ }
    this.finish(cur);
  }

  private setDuck(on: boolean): void {
    if (this.ducked === on) return;
    this.ducked = on;
    try { this.o.onDuck?.(on); } catch { /* ignore */ }
  }

  private armRvfc(): void {
    const v = this.o.video as RvfcVideo | null | undefined;
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
    const loop = () => {
      if (!this.running) return;
      this.tick();
      this.rvfcHandle = v.requestVideoFrameCallback!(loop);
    };
    try { this.rvfcHandle = v.requestVideoFrameCallback(loop); } catch { /* ignore */ }
  }
}

const DEFAULTS = { leadMs: 80, lateSkipMs: 300, tickMs: 50, duckLeadMs: 150, duckRestoreMs: 250, duckHoldMs: 400, maxTotalRate: 2, maxLagMs: 0, maxCatchUp: 1.35 };

function safeRate(r: number): number {
  return Number.isFinite(r) && r > 0 ? r : 1;
}

/** First index with lines[i].start >= t. */
export function lowerBound(lines: readonly Line[], t: number): number {
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (lines[m].start < t) lo = m + 1; else hi = m;
  }
  return lo;
}

/** First index with lines[i].start > t. */
function upperBound(lines: readonly Line[], t: number): number {
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (lines[m].start <= t) lo = m + 1; else hi = m;
  }
  return lo;
}
