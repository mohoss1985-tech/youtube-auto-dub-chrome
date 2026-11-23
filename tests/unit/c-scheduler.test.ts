import { describe, it, expect, afterEach, vi } from 'vitest';
import { Scheduler, lowerBound } from '../../src/content/sync/scheduler';
import type { Clock, Speaker } from '../../src/content/sync/scheduler';
import type { PlayEnd, PlayHandle } from '../../src/content/voice/engine';
import type { Line, Plan } from '../../src/shared/types';

/** Deterministic PRNG. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

class FakeClock implements Clock {
  t = 0; rate = 1; isPaused = false;
  now() { return this.t; }
  playbackRate() { return this.rate; }
  paused() { return this.isPaused; }
}

interface Spoken { plan: Plan; t0: number; endAt: number; state: 'playing' | 'paused' | PlayEnd; resolve: (r: PlayEnd) => void; handle: PlayHandle }

/** Speaker whose lines last `durMs(plan)` media ms (≥ fit duration sometimes, to force cuts). */
class FakeSpeaker implements Speaker {
  spoken: Spoken[] = [];
  constructor(private clock: FakeClock, private durMs: (p: Plan) => number) {}
  speak(plan: Plan): PlayHandle {
    let resolve!: (r: PlayEnd) => void;
    const done = new Promise<PlayEnd>((r) => { resolve = r; });
    const rec: Spoken = { plan, t0: this.clock.t, endAt: this.clock.t + this.durMs(plan) / 1000, state: 'playing', resolve, handle: null as unknown as PlayHandle };
    const end = (r: PlayEnd) => { if (rec.state === 'playing' || rec.state === 'paused') { rec.state = r; resolve(r); } };
    rec.handle = { done, stop: () => end('stopped'), pause: () => { if (rec.state === 'playing') rec.state = 'paused'; }, resume: () => { if (rec.state === 'paused') rec.state = 'playing'; } };
    this.spoken.push(rec);
    return rec.handle;
  }
  stopAll() { for (const s of this.spoken) s.handle.stop(); }
  /** End lines whose time has passed. Returns true if any ended. */
  advance(): boolean {
    let any = false;
    for (const s of this.spoken) if (s.state === 'playing' && this.clock.t >= s.endAt) { s.state = 'ended'; s.resolve('ended'); any = true; }
    return any;
  }
  playingCount() { return this.spoken.filter((s) => s.state === 'playing' || s.state === 'paused').length; }
}

function synthTrack(seconds: number, seed = 1): Line[] {
  const r = rng(seed);
  const lines: Line[] = [];
  let t = 2;
  let i = 0;
  while (t < seconds) {
    const dur = 1 + r() * 5;
    const words = Math.max(1, Math.round(dur * 2.5 + (r() - 0.5) * 6));
    lines.push({ id: `l${i++}`, start: t, end: t + dur, text: 'mot '.repeat(words).trim() });
    t += dur + r() * 1.5;
  }
  return lines;
}

const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

afterEach(() => vi.useRealTimers());

describe('Scheduler (fake clock)', () => {
  it('1 h track: every line starts within 300 ms, no drift growth, overruns cut', async () => {
    const lines = synthTrack(3600, 7);
    expect(lines.length).toBeGreaterThan(500);
    const clock = new FakeClock();
    const r = rng(99);
    // 30 % of lines run 1.5× too long (engine slower than estimate) → must be cut, never delay the next.
    const speaker = new FakeSpeaker(clock, (p) => (p.line.end - p.line.start) * 1000 * (r() < 0.3 ? 1.5 : 0.8));
    const late: number[] = [];
    const sch = new Scheduler(lines, clock, speaker, { lang: 'fr', leadMs: 80, onLineStart: (_p, lateMs) => late.push(lateMs) });
    // start() arms a real interval; we drive tick() manually with jittered steps.
    vi.useFakeTimers();
    sch.start();
    const j = rng(3);
    while (clock.t < 3605) {
      clock.t += 0.03 + j() * 0.04; // 30–70 ms ticks
      if (speaker.advance()) await flush();
      sch.tick();
      expect(speaker.playingCount()).toBeLessThanOrEqual(1);
    }
    sch.stop();
    expect(late.length).toBe(lines.length); // nothing skipped
    for (const l of late) {
      expect(l).toBeLessThanOrEqual(300);
      expect(l).toBeGreaterThanOrEqual(-80 - 1e-6);
    }
    // No drift growth: last 100 lines as punctual as the first 100.
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(Math.abs(avg(late.slice(-100)) - avg(late.slice(0, 100)))).toBeLessThan(30);
    // Overrun lines were cut, not left to run into the next one.
    expect(speaker.spoken.some((s) => s.state === 'stopped')).toBe(true);
  });

  it('skips a line more than 300 ms late instead of carrying lag', () => {
    const clock = new FakeClock();
    const speaker = new FakeSpeaker(clock, () => 500);
    const lines: Line[] = [{ id: 'a', start: 1, end: 2, text: 'a' }, { id: 'b', start: 3, end: 4, text: 'b' }];
    vi.useFakeTimers();
    const sch = new Scheduler(lines, clock, speaker);
    sch.start();
    clock.t = 1.5; // jumped past line a by 500 ms (tab throttled)
    sch.tick();
    expect(speaker.spoken.length).toBe(0);
    clock.t = 2.95;
    sch.tick();
    expect(speaker.spoken.map((s) => s.plan.line.id)).toEqual(['b']);
    sch.stop();
  });

  it('seek stops speech and binary-searches the cursor', () => {
    const lines = synthTrack(1800, 2);
    const clock = new FakeClock();
    const speaker = new FakeSpeaker(clock, () => 10_000);
    vi.useFakeTimers();
    const sch = new Scheduler(lines, clock, speaker);
    sch.start();
    clock.t = lines[3].start;
    sch.tick();
    expect(speaker.playingCount()).toBe(1);
    const target = lines[200].start + 0.01;
    clock.t = target;
    sch.seek(target);
    expect(speaker.playingCount()).toBe(0);
    expect(sch.cursorIndex()).toBe(200);
    sch.tick();
    expect(speaker.spoken.at(-1)!.plan.line.id).toBe(lines[200].id);
    // Backwards seek.
    clock.t = lines[10].start - 1;
    sch.seek(clock.t);
    expect(sch.cursorIndex()).toBe(10);
    expect(lowerBound(lines, -5)).toBe(0);
    expect(lowerBound(lines, 1e9)).toBe(lines.length);
    sch.stop();
  });

  it('pause/resume forwards to the playing handle and holds new lines', () => {
    const clock = new FakeClock();
    const speaker = new FakeSpeaker(clock, () => 1000);
    const lines: Line[] = [{ id: 'a', start: 1, end: 3, text: 'a' }, { id: 'b', start: 4, end: 5, text: 'b' }];
    vi.useFakeTimers();
    const sch = new Scheduler(lines, clock, speaker);
    sch.start();
    clock.t = 1; sch.tick();
    sch.pause();
    expect(speaker.spoken[0].state).toBe('paused');
    clock.t = 4; sch.tick();
    expect(speaker.spoken.length).toBe(1);
    sch.resume();
    expect(speaker.spoken[0].state === 'playing' || speaker.spoken[0].state === 'stopped').toBe(true);
    expect(speaker.spoken.at(-1)!.plan.line.id).toBe('b');
    sch.stop();
  });

  it('multiplies rate by playbackRate and skips lines the voice cannot keep up with', () => {
    const clock = new FakeClock();
    const speaker = new FakeSpeaker(clock, () => 100);
    const lines: Line[] = [{ id: 'a', start: 1, end: 3, text: 'a' }, { id: 'b', start: 4, end: 5, text: 'b' }];
    vi.useFakeTimers();
    const sch = new Scheduler(lines, clock, speaker, { plan: (line) => ({ line, rate: 1.2, startAt: line.start, maxMs: 2000, trimmed: false }) });
    sch.start();
    clock.rate = 1.5; clock.t = 1; sch.tick();
    expect(speaker.spoken[0].plan.rate).toBeCloseTo(1.8, 9);
    clock.rate = 3; clock.t = 4; sch.tick(); // 1.2 × 3 = 3.6 > 2 × 1.5 → skipped
    expect(speaker.spoken.length).toBe(1);
    sch.stop();
  });

  it('ducks before a line and restores after, holding across close lines', async () => {
    const clock = new FakeClock();
    const speaker = new FakeSpeaker(clock, () => 900);
    const duck: [number, boolean][] = [];
    const lines: Line[] = [
      { id: 'a', start: 1, end: 2, text: 'a' },
      { id: 'b', start: 2.2, end: 3, text: 'b' }, // within 400 ms of a's end → hold
      { id: 'c', start: 8, end: 9, text: 'c' },
    ];
    vi.useFakeTimers();
    const sch = new Scheduler(lines, clock, speaker, { onDuck: (on) => duck.push([clock.t, on]) });
    sch.start();
    while (clock.t < 10) {
      clock.t = Math.round((clock.t + 0.05) * 1000) / 1000;
      if (speaker.advance()) await flush();
      sch.tick();
    }
    sch.stop();
    // down before a (≥ 150 ms ahead of start-lead), up once after b, down for c, up after c
    expect(duck[0][1]).toBe(true);
    expect(duck[0][0]).toBeLessThanOrEqual(1 - 0.08 - 0.1);
    const ups = duck.filter(([, on]) => !on);
    expect(ups[0][0]).toBeGreaterThan(3); // not restored between a and b
    expect(ups[0][0]).toBeLessThan(4);
    expect(duck.filter(([, on]) => on).length).toBe(2);
    expect(duck.at(-1)![1]).toBe(false);
  });

  it('setLines keeps the cursor by time and never replays a started line', () => {
    const clock = new FakeClock();
    const speaker = new FakeSpeaker(clock, () => 100);
    vi.useFakeTimers();
    const first: Line[] = [{ id: 'a', start: 1, end: 2, text: 'a' }];
    const sch = new Scheduler(first, clock, speaker);
    sch.start();
    clock.t = 1; sch.tick();
    clock.t = 1.15;
    sch.setLines([...first, { id: 'b', start: 3, end: 4, text: 'b' }, { id: 'z', start: 0.5, end: 0.9, text: 'z' }]);
    sch.tick();
    clock.t = 3; sch.tick();
    expect(speaker.spoken.map((s) => s.plan.line.id)).toEqual(['a', 'b']);
    sch.stop();
  });
});
