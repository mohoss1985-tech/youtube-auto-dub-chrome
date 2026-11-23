// S (v1.1): smooth pacing on a fast-talker track — no silence holes, no speed bursts.
import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../src/content/sync/scheduler';
import { planTrack, estimateMs, VoiceCalibration, rateCap, HARD_MAX_RATE } from '../../src/content/sync/fit';
import type { Line } from '../../src/shared/types';
import { fastTalkerTrack, simClock, SimSpeaker, drive, metrics } from './helpers/pace-sim';

async function simulate(o: { slow: number; queue: boolean; calibrate: boolean; seed?: number; log?: string }) {
  const lines = fastTalkerTrack(600, o.seed ?? 11, 1.2);
  const clock = simClock();
  const spk = new SimSpeaker(clock, { slow: o.slow, queue: o.queue, latencyS: 0.12 });
  const cal = new VoiceCalibration();
  const sch: Scheduler = new Scheduler(lines, clock, spk, {
    lang: 'fr', maxLagMs: 6000, tickMs: 1e9,
    planTrack: (ls) => planTrack(ls, (l) => ({ u: estimateMs(l.text, 'fr'), f: cal.factor('v') })),
  });
  await drive(sch, clock, spk, 615, (r) => {
    // Calibrate from the measured speech duration (onstart→onend × rate).
    if (o.calibrate && cal.update('v', estimateMs(r.plan.line.text, 'fr'), (r.end - r.start) * 1000 * r.plan.rate)) sch.replan();
  });
  const m = metrics(lines, spk.recs);
  if (o.log) console.log(o.log, lines.length, JSON.stringify(m));
  return { m, cal, lines };
}

function expectGoals(m: ReturnType<typeof metrics>) {
  expect(m.spokenShare).toBeGreaterThanOrEqual(0.95);
  expect(m.stopped).toBe(0); // never cut mid-sentence
  expect(m.maxSilenceS).toBeLessThanOrEqual(1.2);
  expect(m.maxRate).toBeLessThanOrEqual(HARD_MAX_RATE + 1e-9);
  expect(m.maxRateStep).toBeLessThanOrEqual(0.08 + 1e-9);
  expect(m.maxLagS).toBeLessThanOrEqual(3);
}

describe('fast-talker 10-min track (density ~90 %, French +20 %)', () => {
  it('track really is dense', () => {
    const lines = fastTalkerTrack();
    const speech = lines.reduce((a, l) => a + l.end - l.start, 0);
    expect(speech / (lines.at(-1)!.end - lines[0].start)).toBeGreaterThan(0.86);
  });

  it('voice matches the prior: all goals met (Web Speech queue)', async () => {
    const { m } = await simulate({ slow: 1, queue: true, calibrate: true, log: 'AFTER slow1 queue' });
    expectGoals(m);
  });

  it('voice 12 % slower than the prior, calibrated live: all goals met', async () => {
    const { m, cal } = await simulate({ slow: 1.12, queue: true, calibrate: true, log: 'AFTER slow1.12 queue+cal' });
    expectGoals(m);
    expect(cal.factor('v')).toBeCloseTo(1 / 1.12, 1);
  });

  it('engine without a queue (audio engines, start latency) still meets the goals', async () => {
    const { m } = await simulate({ slow: 1.12, queue: false, calibrate: true, log: 'AFTER slow1.12 noqueue+cal' });
    expectGoals(m);
  });

  it('other seeds', async () => {
    for (const seed of [3, 5, 8]) {
      const { m } = await simulate({ slow: 1.08, queue: true, calibrate: true, seed });
      expectGoals(m);
    }
  });
});

describe('planTrack', () => {
  const L = (start: number, end: number, text: string): Line => ({ id: `${start}`, start, end, text });

  it('one uniform rate per cluster; clusters split at gaps ≥ 0.7 s', () => {
    const lines = [L(0, 2, 'x'), L(2.2, 4, 'x'), L(4.3, 6, 'x'), L(7, 9, 'x')];
    const u = [3000, 1500, 2400, 1000];
    const p = planTrack(lines, (_l, i) => ({ u: u[i], f: 1 }), { step: 1 });
    expect(p.map((x) => x.cluster)).toEqual([0, 0, 0, 1]);
    expect(p[0].rate).toBeCloseTo(p[1].rate, 9);
    expect(p[1].rate).toBeCloseTo(p[2].rate, 9);
    // 6.9 s of speech into [−0.4, 6.6] (early start + tail capped 0.3 s before the next cluster) → ~0.986 → rate 1
    expect(p[0].rate).toBe(1);
    expect(p[3].rate).toBe(1);
  });

  it('starts a crowded cluster up to 0.4 s early, and only when needed', () => {
    const ls = [L(5, 7, 'x'), L(7.1, 9, 'y'), L(9.8, 11, 'z')];
    const crowded = planTrack(ls, (_l, i) => ({ u: i < 2 ? 3000 : 500, f: 1 }));
    expect(crowded[0].startAt).toBeCloseTo(4.6, 6);
    expect(crowded[0].rate).toBeGreaterThan(1);
    expect(crowded[1].startAt).toBe(7.1);
    const easy = planTrack(ls, () => ({ u: 1000, f: 1 }));
    expect(easy[0].startAt).toBe(5);
  });

  it('caps at 1.3 × voiceSpeed and never above 1.35', () => {
    expect(rateCap(1)).toBeCloseTo(1.3, 9);
    expect(rateCap(1.3)).toBeCloseTo(1.35, 9);
    expect(rateCap(0.75)).toBeCloseTo(0.975, 9);
    const lines = [L(0, 1, 'x'), L(1.1, 2, 'y')];
    for (const vs of [0.75, 1, 1.3]) {
      for (const pl of planTrack(lines, () => ({ u: 9000, f: 1 }), { voiceSpeed: vs })) expect(pl.rate).toBeLessThanOrEqual(rateCap(vs) + 1e-9);
    }
  });

  it('smooths rate between clusters (≤ 0.06 per line in the plan)', () => {
    const lines: Line[] = [];
    for (let i = 0; i < 30; i++) lines.push(L(i * 2, i * 2 + 1.2, 'x'));
    const u = lines.map((_, i) => (i === 15 ? 2600 : 900)); // one crowded line
    const p = planTrack(lines, (_l, i) => ({ u: u[i], f: 1 }));
    for (let i = 1; i < p.length; i++) expect(Math.abs(p[i].rate - p[i - 1].rate)).toBeLessThanOrEqual(0.06 + 1e-9);
    expect(p[15].rate).toBeGreaterThan(1.2);
    expect(p[13].rate).toBeGreaterThan(p[10].rate); // ramps up ahead
  });

  it('per-voice factor: a slower voice gets a higher rate so both sound equally fast', () => {
    const lines = [L(0, 3, 'x'), L(3.2, 6, 'y')];
    const p = planTrack(lines, (_l, i) => ({ u: 2000, f: i === 0 ? 1 : 0.85 }), { step: 1 });
    expect(p[0].rate * p[0].factor).toBeCloseTo(p[1].rate * p[1].factor, 6); // same pace
    expect(p[1].rate).toBeGreaterThan(p[0].rate);
  });
});
