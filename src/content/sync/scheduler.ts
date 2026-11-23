// Media-time-driven line scheduler (§5). Owner: C.
import type { Lang, Line, Plan } from '../../shared/types';
import type { PlayEnd, PlayHandle } from '../voice/engine';
import { fit } from './fit';

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
}

export interface SchedulerOptions {
  lang?: Lang;
  /** Start lead in ms (80 WebSpeech / 30 audio). */
  leadMs?: number;
  /** Skip a not-started line this late (default 300 ms). */
  lateSkipMs?: number;
  /**
   * Continuous mode (> 0): never cut a line because the next one is due. The next line waits for the
   * current one to finish and then starts with a catch-up rate. Lag is bounded by this value: lines
   * later than this when the voice is free are skipped. 0 = strict mode (cut overruns, 300 ms late skip).
   */
  maxLagMs?: number;
  /** Extra rate multiplier allowed to catch up in continuous mode (default 1.35). */
  maxCatchUp?: number;
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

/** Drives speech from clock time; lag never carries over (late lines skipped, overruns cut). */
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
    // Skip lines that are too late to start. Continuous: only when the voice is free, with the larger lag budget.
    const skipAfter = continuous ? Math.max(late, this.o.maxLagMs / 1000) : late;
    if (!continuous || !busy) {
      while (this.cursor < this.lines.length && t > this.lines[this.cursor].start + skipAfter) this.cursor++;
    }

    const next = this.lines[this.cursor];
    if (next && t >= next.start - lead && continuous && busy) {
      // Let the current line finish; the next one starts right after it (no cut, no gap).
    } else if (next && t >= next.start - lead) {
      this.startLine(this.cursor, t);
    } else if (next && !this.ducked && t >= next.start - lead - this.o.duckLeadMs / 1000) {
      this.setDuck(true);
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
  }

  resume(): void {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    if (this.cur && !this.cur.ended) {
      try { this.cur.handle.resume(); } catch { /* ignore */ }
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
    // Next line = first one not yet due-and-missed, and after the last line already started (never replay).
    let c = lowerBound(this.lines, this.clock.now() - this.o.lateSkipMs / 1000);
    if (this.lastStartedAt != null) c = Math.max(c, upperBound(this.lines, this.lastStartedAt));
    this.cursor = c;
  }

  // ---------------- internals ----------------

  private startLine(i: number, t: number): void {
    const line = this.lines[i];
    this.cursor = i + 1;
    this.lastStartedAt = line.start;
    if (this.cur && !this.cur.ended) this.cutCurrent(); // previous overran: cut
    const plan = (this.o.plan ?? ((l, n) => fit(l, n, this.o.lang ?? 'en')))(line, this.lines[i + 1]);
    const vr = safeRate(this.clock.playbackRate());
    const wanted = plan.rate * vr;
    // Video sped up so much the voice cannot keep up: skip lines that would lose more than a third.
    if (wanted / this.o.maxTotalRate > 1.5) return;
    let rate = Math.min(wanted, this.o.maxTotalRate);
    // Continuous mode: started late because the previous line ran long → speak a bit faster to catch up.
    const lag = t - line.start;
    if (this.o.maxLagMs > 0 && lag > 0.15) {
      const dur = Math.max(1, line.end - line.start);
      const boost = Math.min(this.o.maxCatchUp, 1 + lag / dur);
      rate = Math.min(rate * boost, this.o.maxTotalRate);
    }
    this.setDuck(true);
    let handle: PlayHandle;
    try {
      handle = this.speaker.speak({ ...plan, rate });
    } catch {
      this.speechEndT = t;
      return;
    }
    const cur: Current = { plan, index: i, handle, t0: t, rate, ended: false };
    this.cur = cur;
    this.speechEndT = null;
    const id = ++this.seq;
    this.o.onLineStart?.({ ...plan, rate }, (t - plan.startAt) * 1000);
    Promise.resolve(handle.done).then(
      (r: PlayEnd) => this.onDone(cur, id, r),
      () => this.onDone(cur, id, 'error'),
    );
  }

  private onDone(cur: Current, _id: number, _r: PlayEnd): void {
    if (cur.ended) return;
    this.finish(cur);
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
