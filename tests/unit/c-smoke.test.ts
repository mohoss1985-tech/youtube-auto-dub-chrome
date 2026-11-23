// Wave 0 smoke for owner C: modules import.
import { describe, it, expect } from 'vitest';
import * as fit from '../../src/content/sync/fit';
import { Scheduler } from '../../src/content/sync/scheduler';
import { SpeakerPitch } from '../../src/content/sync/pitch';
import { PlayerWatcher, onNavigate } from '../../src/content/sync/player';
import { DubSession } from '../../src/content/session';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

describe('C smoke', () => {
  it('exports the §8 names', () => {
    expect(fit.MAX_RATE).toBe(1.3);
    expect(fit.CPS).toEqual({ en: 14, es: 15, fr: 14, tr: 13, ar: 12 });
    for (const f of [fit.fit, fit.estimateMs, onNavigate]) expect(f).toBeTypeOf('function');
    for (const c of [Scheduler, SpeakerPitch, PlayerWatcher, DubSession]) expect(c).toBeTypeOf('function');
    const s = new DubSession({ videoId: 'abc', settings: { ...DEFAULT_SETTINGS } });
    expect(s.getStatus().state).toBe('idle');
  });
});
