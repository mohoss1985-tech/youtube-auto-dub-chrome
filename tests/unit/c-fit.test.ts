import { describe, it, expect } from 'vitest';
import { fit, estimateMs, MAX_RATE, CPS } from '../../src/content/sync/fit';
import type { Line } from '../../src/shared/types';

const L = (start: number, end: number, text: string, id = `${start}`): Line => ({ id, start, end, text });

describe('estimateMs', () => {
  it('uses per-language CPS plus pauses', () => {
    const t = 'a'.repeat(140);
    expect(estimateMs(t, 'en')).toBeCloseTo((140 / CPS.en) * 1000, 5);
    expect(estimateMs(t, 'ar')).toBeGreaterThan(estimateMs(t, 'es'));
    expect(estimateMs('Hi, there.', 'en')).toBeCloseTo((10 / 14) * 1000 + 240, 5);
    expect(estimateMs('   ', 'fr')).toBe(0);
  });
  it('cpsFactor speeds up the estimate', () => {
    expect(estimateMs('hello world', 'en', { cpsFactor: 2 })).toBeCloseTo(estimateMs('hello world', 'en') / 2, 5);
  });
});

describe('fit', () => {
  it('keeps rate 1 when the line fits', () => {
    const p = fit(L(10, 14, 'short'), L(15, 17, 'x'), 'en');
    expect(p.rate).toBe(1);
    expect(p.startAt).toBe(10);
    expect(p.trimmed).toBe(false);
  });

  it('never exceeds 1.3 × voiceSpeed', () => {
    const long = 'word '.repeat(200);
    for (const vs of [0.75, 1, 1.3]) {
      const p = fit(L(0, 2, long), L(2.2, 4, 'x'), 'fr', undefined, { voiceSpeed: vs });
      expect(p.rate).toBeLessThanOrEqual(MAX_RATE * vs + 1e-9);
      expect(p.rate).toBeCloseTo(MAX_RATE * vs, 9);
      expect(p.trimmed).toBe(true);
    }
  });

  it('speeds up between 1 and 1.3 when slightly too long', () => {
    // slot = min(next-0.1, end+0.6) - start = 2.6 s; natural 3000 ms → rate ≈ 1.154
    const p = fit(L(0, 2, 'x'), L(5, 6, 'y'), 'en', 3000);
    expect(p.rate).toBeCloseTo(3000 / 2600, 3);
    expect(p.trimmed).toBe(false);
  });

  it('borrows the gap before cutting', () => {
    // slot 2.6 s, rate capped 1.3 → 4000/1.3 = 3077 ms > slot, but gap to next−0.1 = 4.9 s
    const p = fit(L(0, 2, 'x'), L(5, 6, 'y'), 'en', 4000);
    expect(p.rate).toBeCloseTo(1.3, 9);
    expect(p.maxMs).toBeCloseTo(4900, 6);
    expect(p.trimmed).toBe(false);
  });

  it('cuts at maxMs when even the gap is too short', () => {
    const p = fit(L(0, 2, 'x'), L(2.5, 6, 'y'), 'en', 9000);
    expect(p.maxMs).toBeCloseTo(2400, 6);
    expect(p.trimmed).toBe(true);
  });

  it('last line may borrow a tail', () => {
    const p = fit(L(0, 2, 'x'), undefined, 'en', 1000);
    expect(p.maxMs).toBeGreaterThanOrEqual(2600);
  });

  it('overlapping next line keeps a minimum slot', () => {
    const p = fit(L(5, 6, 'x'), L(5, 7, 'y'), 'en', 1000);
    expect(p.maxMs).toBeGreaterThanOrEqual(200);
    expect(p.rate).toBeLessThanOrEqual(1.3);
  });
});
