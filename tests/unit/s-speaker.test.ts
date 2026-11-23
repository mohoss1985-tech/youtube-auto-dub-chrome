// S (v1.1): stable speaker switching (hysteresis, markers, shouting guard).
import { describe, it, expect } from 'vitest';
import { SpeakerTracker, speakerMarker, CONF_MALE_HZ, CONF_FEMALE_HZ } from '../../src/content/sync/pitch';
import type { LineEvidence } from '../../src/content/sync/pitch';

const ev = (t: number, f0: number | null, o: Partial<LineEvidence> = {}): LineEvidence => ({ t, f0, voicedShare: 0.7, rms: 0.1, ...o });
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

describe('SpeakerTracker', () => {
  it('thresholds: < 155 male, > 205 female, in between no evidence', () => {
    const tr = new SpeakerTracker();
    expect(CONF_MALE_HZ).toBe(155);
    expect(CONF_FEMALE_HZ).toBe(205);
    expect(tr.observe(ev(0, 180))).toBe('unknown');
    expect(tr.observe(ev(3, 140))).toBe('male');
    expect(tr.observe(ev(30, 190))).toBe('male');
  });

  it('alternating noise without markers never flips', () => {
    const tr = new SpeakerTracker();
    tr.observe(ev(0, 120));
    const r = rng(4);
    for (let i = 1; i < 300; i++) {
      // a confident opposite reading every other line, the rest ambiguous or male, all with random loudness
      const f0 = i % 2 ? 215 + r() * 60 : (r() < 0.5 ? 160 + r() * 40 : 130 + r() * 20);
      expect(tr.observe(ev(i * 2.5, f0, { rms: 0.05 + r() * 0.1 }))).toBe('male');
    }
    expect(tr.switches).toBe(0);
  });

  it('real speaker change (marker + evidence) flips within 1 line', () => {
    const tr = new SpeakerTracker();
    for (let i = 0; i < 5; i++) tr.observe(ev(i * 2, 120));
    expect(tr.observe(ev(10.5, 230, { marker: true }))).toBe('female'); // the marker line itself
    // marker on a short/unvoiced line: the next confident line confirms
    expect(tr.observe(ev(12, null, { marker: true, voicedShare: 0 }))).toBe('female');
    expect(tr.observe(ev(13, 125))).toBe('male');
  });

  it('without markers: 2 consecutive confident lines and ≥ 6 s since the last switch', () => {
    const tr = new SpeakerTracker();
    tr.observe(ev(0, 120));
    expect(tr.observe(ev(7, 230, { rms: 0.05 }))).toBe('male'); // one line is not enough
    expect(tr.observe(ev(9, 180, { rms: 0.05 }))).toBe('male'); // unclear line breaks the run
    expect(tr.observe(ev(11, 230, { rms: 0.05 }))).toBe('male');
    expect(tr.observe(ev(13, 235, { rms: 0.05 }))).toBe('female'); // 2 consecutive confident lines
  });

  it('6 s minimum between evidence-only switches', () => {
    const tr = new SpeakerTracker();
    tr.observe(ev(0, 120));
    tr.observe(ev(1, 230, { rms: 0.05 }));
    expect(tr.observe(ev(2, 230, { rms: 0.05 }))).toBe('male'); // only 2 s after the first voice was set
    expect(tr.observe(ev(6.5, 230, { rms: 0.05 }))).toBe('female');
  });

  it('shouting man (high F0 + loudest 20 %) stays male', () => {
    const tr = new SpeakerTracker();
    const r = rng(9);
    for (let i = 0; i < 20; i++) tr.observe(ev(i * 2, 115 + r() * 25, { rms: 0.04 + r() * 0.04 }));
    for (let i = 20; i < 40; i++) {
      // NBA commentator yelling: F0 240–320 Hz, very loud; normal lines in between
      const shout = i % 3 !== 0;
      tr.observe(ev(i * 2, shout ? 240 + r() * 80 : 125, { rms: shout ? 0.3 + r() * 0.1 : 0.06 }));
      expect(tr.current()).toBe('male');
    }
  });

  it('caption label is authoritative', () => {
    const tr = new SpeakerTracker();
    tr.observe(ev(0, 120));
    expect(tr.observe(ev(1, 120, { hint: 'female' }))).toBe('female');
  });

  it('speakerMarker reads Line.newSpeaker and >> / dash prefixes', () => {
    expect(speakerMarker({ id: 'a', start: 0, end: 1, text: 'Salut', newSpeaker: true })).toBe(true);
    expect(speakerMarker({ id: 'a', start: 0, end: 1, text: 'Salut', source: '>> Hi' })).toBe(true);
    expect(speakerMarker({ id: 'a', start: 0, end: 1, text: '- Salut !' })).toBe(true);
    expect(speakerMarker({ id: 'a', start: 0, end: 1, text: 'Salut-toi' })).toBe(false);
  });
});
