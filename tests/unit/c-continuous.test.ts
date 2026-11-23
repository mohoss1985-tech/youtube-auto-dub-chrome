import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../src/content/sync/scheduler';
import type { Clock, Speaker } from '../../src/content/sync/scheduler';
import type { PlayEnd, PlayHandle } from '../../src/content/voice/engine';
import type { Line, Plan } from '../../src/shared/types';

class FakeClock implements Clock {
  t = 0;
  now() { return this.t; }
  playbackRate() { return 1; }
  paused() { return false; }
}
interface Rec { plan: Plan; t0: number; endAt: number; state: string; resolve: (r: PlayEnd) => void }
class FakeSpeaker implements Speaker {
  spoken: Rec[] = [];
  constructor(private clock: FakeClock, private durS: (p: Plan) => number) {}
  speak(plan: Plan): PlayHandle {
    let resolve!: (r: PlayEnd) => void;
    const done = new Promise<PlayEnd>((r) => { resolve = r; });
    const rec: Rec = { plan, t0: this.clock.t, endAt: this.clock.t + this.durS(plan), state: 'playing', resolve };
    this.spoken.push(rec);
    return { done, stop: () => { if (rec.state === 'playing') { rec.state = 'stopped'; resolve('stopped'); } }, pause() {}, resume() {} };
  }
  stopAll() { for (const s of this.spoken) if (s.state === 'playing') { s.state = 'stopped'; s.resolve('stopped'); } }
  advance() { for (const s of this.spoken) if (s.state === 'playing' && this.clock.t >= s.endAt) { s.state = 'ended'; s.resolve('ended'); } }
}
const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

async function run(lines: Line[], durS: (p: Plan) => number, until: number, opts = { maxLagMs: 2500 }) {
  const clock = new FakeClock();
  const spk = new FakeSpeaker(clock, durS);
  const s = new Scheduler(lines, clock, spk, { ...opts, tickMs: 1e9, lang: 'fr' });
  s.start();
  for (clock.t = 0; clock.t <= until; clock.t = +(clock.t + 0.05).toFixed(2)) { spk.advance(); await flush(); s.tick(); }
  s.stop();
  return spk;
}

describe('continuous mode (no cuts)', () => {
  it('never cuts a line that runs into the next one; next starts right after, faster', async () => {
    const lines: Line[] = [
      { id: 'a', start: 1, end: 3, text: 'premier' },
      { id: 'b', start: 3.2, end: 5, text: 'second' },
      { id: 'c', start: 6, end: 8, text: 'troisième' },
    ];
    // 'a' lasts 3.5 s (runs 1.3 s into 'b')
    const spk = await run(lines, (p) => (p.line.id === 'a' ? 3.5 : 1.5), 10);
    expect(spk.spoken.map((r) => r.plan.line.id)).toEqual(['a', 'b', 'c']);
    expect(spk.spoken.every((r) => r.state === 'ended')).toBe(true); // nothing stopped mid-sentence
    const b = spk.spoken[1];
    expect(b.t0).toBeCloseTo(spk.spoken[0].endAt, 1); // starts as soon as 'a' ends
    expect(b.plan.rate).toBeGreaterThan(spk.spoken[2].plan.rate); // catch-up rate
    expect(b.plan.rate).toBeLessThanOrEqual(2);
  });

  it('lag stays bounded: lines later than 2.5 s are skipped, the rest are whole', async () => {
    const lines: Line[] = Array.from({ length: 40 }, (_, i) => ({ id: `l${i}`, start: 1 + i * 1.5, end: 2.4 + i * 1.5, text: 'mot mot mot' }));
    const spk = await run(lines, () => 2.4, 70); // every line 1 s too long
    for (const r of spk.spoken) expect(r.t0 - r.plan.line.start).toBeLessThanOrEqual(2.55);
    expect(spk.spoken.filter((r) => r.state === 'stopped').length).toBe(0);
  });

  it('strict mode (maxLagMs 0) still cuts overruns as before', async () => {
    const lines: Line[] = [
      { id: 'a', start: 1, end: 3, text: 'premier' },
      { id: 'b', start: 3.2, end: 5, text: 'second' },
    ];
    const spk = await run(lines, (p) => (p.line.id === 'a' ? 3.5 : 1.5), 6, { maxLagMs: 0 });
    expect(spk.spoken[0].state).toBe('stopped');
  });
});
