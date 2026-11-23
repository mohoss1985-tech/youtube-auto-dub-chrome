// Media-time-driven line scheduler (§5). Owner: C.
import type { Lang, Line, Plan } from '../../shared/types';
import type { PlayHandle } from '../voice/engine';

/** Media clock (seconds). Real: wraps <video>; tests: fake clock. */
export interface Clock {
  /** Current media time in seconds. */
  now(): number;
  /** Video playbackRate. */
  playbackRate(): number;
  paused(): boolean;
}

/** Plays a planned line. DubSession adapts a TtsEngine (+ prepared cache) to this. */
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
  /** Tick period in ms (default 50). */
  tickMs?: number;
  /** Build a plan for line i (default: fit(lines[i], lines[i+1], lang)). */
  plan?: (line: Line, next: Line | undefined) => Plan;
  onLineStart?: (plan: Plan, lateMs: number) => void;
  onLineEnd?: (plan: Plan, overflowMs: number) => void;
}

/** Drives speech from clock time; lag never carries over (late lines skipped, overruns cut). */
export class Scheduler {
  constructor(lines: Line[], clock: Clock, speaker: Speaker, opts?: SchedulerOptions) {
    void lines; void clock; void speaker; void opts;
  }

  /** Start ticking (50 ms + requestVideoFrameCallback when available). */
  start(): void {
    throw new Error('TODO C');
  }

  /** Stop ticking and all speech. */
  stop(): void {
    // TODO C
  }

  /** One scheduling step (public for fake-clock tests). */
  tick(): void {
    throw new Error('TODO C');
  }

  /** Stop speech and binary-search the cursor to media time `t` (seconds). */
  seek(t: number): void {
    void t;
    throw new Error('TODO C');
  }

  pause(): void {
    // TODO C
  }

  resume(): void {
    // TODO C
  }

  /** Replace lines (e.g. after translation of later batches); keeps cursor by time. */
  setLines(lines: Line[]): void {
    void lines;
    throw new Error('TODO C');
  }
}
