import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlayerWatcher, onNavigate } from '../../src/content/sync/player';

export class FakeVideo extends EventTarget {
  currentTime = 0; paused = false; seeking = false; playbackRate = 1; muted = false;
  private _v = 0.8;
  get volume() { return this._v; }
  set volume(v: number) { this._v = v; this.dispatchEvent(new Event('volumechange')); }
  /** User drags the volume slider. */
  userVolume(v: number) { this.volume = v; }
}

afterEach(() => vi.useRealTimers());

describe('PlayerWatcher', () => {
  it('ducks with ramps and restores on stop', () => {
    vi.useFakeTimers();
    const v = new FakeVideo();
    const w = new PlayerWatcher(v as unknown as HTMLVideoElement, null, {});
    w.start();
    w.duck(true, 0.15);
    vi.advanceTimersByTime(75);
    expect(v.volume).toBeLessThan(0.8);
    expect(v.volume).toBeGreaterThan(0.12);
    vi.advanceTimersByTime(100);
    expect(v.volume).toBeCloseTo(0.12, 5);
    w.duck(false);
    vi.advanceTimersByTime(125);
    expect(v.volume).toBeLessThan(0.8);
    vi.advanceTimersByTime(150);
    expect(v.volume).toBeCloseTo(0.8, 5);
    w.duck(true, 0.15);
    vi.advanceTimersByTime(200);
    w.stop();
    expect(v.volume).toBeCloseTo(0.8, 5);
  });

  it('a user volume change becomes the new baseline', () => {
    vi.useFakeTimers();
    const v = new FakeVideo();
    const w = new PlayerWatcher(v as unknown as HTMLVideoElement, null, {});
    w.start();
    w.duck(true, 0.5);
    vi.advanceTimersByTime(200);
    v.userVolume(0.3);
    w.duck(true, 0.5);
    vi.advanceTimersByTime(200);
    expect(v.volume).toBeCloseTo(0.15, 5);
    w.stop();
    expect(v.volume).toBeCloseTo(0.3, 5);
  });

  it('holds the duck when YouTube resets video.volume behind our back', () => {
    vi.useFakeTimers();
    const v = new FakeVideo();
    const w = new PlayerWatcher(v as unknown as HTMLVideoElement, null, {});
    w.start();
    w.duck(true, 0.1);
    vi.advanceTimersByTime(200);
    expect(v.volume).toBeCloseTo(0.08, 5);
    v.userVolume(1); // YouTube's player writes its own volume back
    vi.advanceTimersByTime(1);
    expect(v.volume).toBeCloseTo(0.1, 5); // re-ducked on top of the new baseline
    w.stop();
    expect(v.volume).toBeCloseTo(1, 5);
  });

  it('uses a gain sink instead of video.volume when given', () => {
    vi.useFakeTimers();
    const v = new FakeVideo();
    const gains: number[] = [];
    const w = new PlayerWatcher(v as unknown as HTMLVideoElement, null, {});
    w.start();
    w.useGain((g) => gains.push(g));
    w.duck(true, 0.2);
    vi.advanceTimersByTime(200);
    expect(v.volume).toBe(0.8);
    expect(gains.at(-1)).toBeCloseTo(0.2, 5);
    w.stop();
    expect(gains.at(-1)).toBe(1);
  });

  it('ad-showing: restores volume, fires onAdStart/onAdEnd, ignores video events during ads', async () => {
    vi.useFakeTimers();
    const v = new FakeVideo();
    const player = document.createElement('div');
    const h = { onAdStart: vi.fn(), onAdEnd: vi.fn(), onPause: vi.fn(), onSeeked: vi.fn() };
    const w = new PlayerWatcher(v as unknown as HTMLVideoElement, player, h);
    w.start();
    w.duck(true, 0.1);
    vi.advanceTimersByTime(200);
    player.classList.add('ad-showing');
    await Promise.resolve(); // MutationObserver microtask
    expect(h.onAdStart).toHaveBeenCalledTimes(1);
    expect(w.isAdShowing()).toBe(true);
    expect(v.volume).toBeCloseTo(0.8, 5);
    w.duck(true, 0.1); // never duck an ad
    vi.advanceTimersByTime(200);
    expect(v.volume).toBeCloseTo(0.8, 5);
    v.dispatchEvent(new Event('pause'));
    v.dispatchEvent(new Event('seeked'));
    expect(h.onPause).not.toHaveBeenCalled();
    expect(h.onSeeked).not.toHaveBeenCalled();
    player.classList.remove('ad-showing');
    await Promise.resolve();
    expect(h.onAdEnd).toHaveBeenCalledTimes(1);
    v.dispatchEvent(new Event('pause'));
    expect(h.onPause).toHaveBeenCalledTimes(1);
    w.stop();
  });
});

describe('onNavigate', () => {
  it('fires on yt-navigate-finish and popstate, deduped by URL, unsubscribes', () => {
    const cb = vi.fn();
    const off = onNavigate(cb);
    history.pushState({}, '', '/watch?v=abc');
    document.dispatchEvent(new Event('yt-navigate-finish'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toContain('/watch?v=abc');
    history.pushState({}, '', '/shorts/xyz');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    history.pushState({}, '', '/watch?v=def');
    document.dispatchEvent(new Event('yt-navigate-finish'));
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
