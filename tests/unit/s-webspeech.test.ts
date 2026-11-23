// S (v1.1): Web Speech gapless queue, measured speech time, cancel semantics.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSpeechEngine } from '../../src/content/voice/webspeech';
import type { SpeechMeasure } from '../../src/content/voice/webspeech';
import type { Line } from '../../src/shared/types';

/** Fake synth with a real FIFO: only the head speaks; onstart at head, onend after `ms` (fake timers). */
class FakeSynth {
  q: any[] = [];
  log: string[] = [];
  speaking = false; pending = false; paused = false;
  ms = 1000;
  private timer: any;
  getVoices() { return [{ name: 'Thomas', lang: 'fr-FR', voiceURI: 'Thomas', localService: true, default: false }]; }
  addEventListener() {} removeEventListener() {}
  speak(u: any) { this.q.push(u); if (this.q.length === 1) this.startHead(); }
  private startHead() {
    const u = this.q[0];
    if (!u || this.paused) return;
    this.log.push(`start:${u.text}`);
    u.onstart?.();
    this.timer = setTimeout(() => { this.q.shift(); this.log.push(`end:${u.text}`); u.onend?.(); this.startHead(); }, this.ms);
  }
  cancel() {
    clearTimeout(this.timer);
    const old = this.q.splice(0);
    for (const u of old) u.onerror?.({ error: 'canceled' });
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
}

const L = (id: string, text: string): Line => ({ id, start: 0, end: 1, text });
let syn: FakeSynth;
beforeEach(() => {
  vi.useFakeTimers();
  syn = new FakeSynth();
  (globalThis as any).speechSynthesis = syn;
  (globalThis as any).SpeechSynthesisUtterance = class {
    text: string; lang = ''; voice: unknown = null; rate = 1; volume = 1;
    onstart: any = null; onend: any = null; onerror: any = null;
    constructor(t: string) { this.text = t; }
  };
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).speechSynthesis;
  delete (globalThis as any).SpeechSynthesisUtterance;
});

describe('WebSpeechEngine queue (v1.1)', () => {
  it('a line played while another speaks starts right after it (no gap), in order', async () => {
    const eng = new WebSpeechEngine();
    expect(eng.canQueue()).toBe(true);
    const a = eng.play({ line: L('a', 'un'), lang: 'fr', engine: 'webspeech' }, 1, 1);
    await vi.advanceTimersByTimeAsync(500);
    const b = eng.play({ line: L('b', 'deux'), lang: 'fr', engine: 'webspeech' }, 1, 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await a.done).toBe('ended');
    expect(syn.log).toEqual(['start:un', 'end:un', 'start:deux']); // same tick: no onend→speak gap
    await vi.advanceTimersByTimeAsync(1000);
    expect(await b.done).toBe('ended');
  });

  it('all chunks of a long line are queued at once, in order', async () => {
    const eng = new WebSpeechEngine();
    const text = 'Une phrase de test assez longue pour être coupée en deux morceaux distincts. '.repeat(4).trim();
    const h = eng.play({ line: L('a', text), lang: 'fr', engine: 'webspeech' }, 1, 1);
    expect(syn.q.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await h.done).toBe('ended');
  });

  it('reports measured speech time (onstart→onend) per line', async () => {
    const eng = new WebSpeechEngine();
    const got: SpeechMeasure[] = [];
    eng.onMeasure = (m) => got.push(m);
    syn.ms = 1500;
    eng.play({ line: L('a', 'bonjour'), lang: 'fr', engine: 'webspeech', voice: 'Thomas' }, 1.2, 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ voice: 'Thomas', rate: 1.2, text: 'bonjour' });
    expect(got[0].speechMs).toBeCloseTo(1500, -1);
  });

  it('stopping the speaking line keeps the queued next line (re-queued), stopAll cancels everything', async () => {
    const eng = new WebSpeechEngine();
    const a = eng.play({ line: L('a', 'un'), lang: 'fr', engine: 'webspeech' }, 1, 1);
    const b = eng.play({ line: L('b', 'deux'), lang: 'fr', engine: 'webspeech' }, 1, 1);
    a.stop();
    expect(await a.done).toBe('stopped');
    expect(syn.q.map((u) => u.text)).toEqual(['deux']);
    const c = eng.play({ line: L('c', 'trois'), lang: 'fr', engine: 'webspeech' }, 1, 1);
    eng.stopAll();
    expect(await b.done).toBe('stopped');
    expect(await c.done).toBe('stopped');
    expect(syn.q.length).toBe(0);
  });

  it('pause holds the watchdog; resume continues', async () => {
    const eng = new WebSpeechEngine();
    syn.ms = 1e9; // never ends by itself → watchdog
    const h = eng.play({ line: L('a', 'un'), lang: 'fr', engine: 'webspeech' }, 1, 1);
    let res: string | undefined;
    void h.done.then((r) => (res = r));
    h.pause();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(res).toBeUndefined();
    h.resume();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(res).toBe('ended');
  });
});
