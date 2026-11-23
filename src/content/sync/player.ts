// Player events, ads, ducking, SPA navigation (§5). Owner: C.

export interface PlayerHandlers {
  onPause?: () => void;
  onPlay?: () => void;
  onSeeking?: (t: number) => void;
  onSeeked?: (t: number) => void;
  onRateChange?: (rate: number) => void;
  onAdStart?: () => void;
  onAdEnd?: () => void;
  onVisibility?: (hidden: boolean) => void;
}

/** Ramp-down duration (ms). */
export const DUCK_DOWN_MS = 150;
/** Ramp-up duration (ms). */
export const DUCK_UP_MS = 250;
const STEP_MS = 25;
const AD_CLASSES = ['ad-showing', 'ad-interrupting'];

/** Watches <video> + #movie_player (ad-showing via MutationObserver) and ramps volume for ducking. */
export class PlayerWatcher {
  private readonly video: HTMLVideoElement;
  private player: HTMLElement | null;
  private readonly h: PlayerHandlers;
  private started = false;
  private observer: MutationObserver | null = null;
  private adShowing = false;
  private readonly off: (() => void)[] = [];
  /** The user's own volume (0..1), learned at start and from user volume changes. */
  private userVolume = 1;
  /** Value we last wrote to video.volume (to tell our writes from the user's). */
  private lastSet: number | null = null;
  /** Current duck multiplier (1 = not ducked). */
  private level = 1;
  private ramp: ReturnType<typeof setInterval> | null = null;
  private gainSink: ((v: number) => void) | null = null;
  private duckLevel = 0.15;

  constructor(video: HTMLVideoElement, player: HTMLElement | null, handlers: PlayerHandlers) {
    this.video = video;
    this.player = player;
    this.h = handlers;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.userVolume = clamp01(this.video.volume);
    const v = this.video;
    const on = <K extends string>(target: EventTarget, type: K, fn: (e: Event) => void) => {
      target.addEventListener(type, fn);
      this.off.push(() => target.removeEventListener(type, fn));
    };
    on(v, 'pause', () => { if (!this.adShowing) this.h.onPause?.(); });
    on(v, 'play', () => { if (!this.adShowing) this.h.onPlay?.(); });
    on(v, 'seeking', () => { if (!this.adShowing) this.h.onSeeking?.(v.currentTime); });
    on(v, 'seeked', () => { if (!this.adShowing) this.h.onSeeked?.(v.currentTime); });
    on(v, 'ratechange', () => this.h.onRateChange?.(v.playbackRate));
    on(v, 'volumechange', () => this.onVolumeChange());
    if (typeof document !== 'undefined') {
      on(document, 'visibilitychange', () => this.h.onVisibility?.(document.visibilityState === 'hidden'));
    }
    this.adShowing = this.readAd();
    if (this.player && typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver(() => this.checkAd());
      this.observer.observe(this.player, { attributes: true, attributeFilter: ['class'] });
    }
  }

  /** Remove listeners and restore the original volume. */
  stop(): void {
    this.restoreVolume();
    this.observer?.disconnect();
    this.observer = null;
    for (const f of this.off.splice(0)) f();
    this.started = false;
  }

  /** Route ducking through a WebAudio GainNode instead of video.volume (null = back to video.volume). */
  useGain(sink: ((v: number) => void) | null): void {
    const cur = this.level;
    if (this.gainSink) this.gainSink(1);
    else if (cur !== 1) this.writeVolume(this.userVolume);
    this.gainSink = sink;
    this.apply(cur);
  }

  /** Default duck level for duck(true) without a level. */
  setDuckLevel(level: number): void {
    this.duckLevel = clamp01(level);
    if (this.level !== 1 && this.targetOn) this.duck(true, this.duckLevel);
  }

  private targetOn = false;

  /** Ramp original audio to `level` (0..1 of user volume) or back (on=false). */
  duck(on: boolean, level?: number): void {
    this.targetOn = on;
    if (on && this.adShowing) return; // never duck an ad
    const target = on ? clamp01(level ?? this.duckLevel) : 1;
    this.rampTo(target, on ? DUCK_DOWN_MS : DUCK_UP_MS);
  }

  /** Restore the user's original volume immediately. */
  restoreVolume(): void {
    this.stopRamp();
    this.targetOn = false;
    if (this.level !== 1) this.apply(1);
    this.level = 1;
    if (this.gainSink) {
      try { this.gainSink(1); } catch { /* ignore */ }
    }
  }

  isAdShowing(): boolean {
    return this.started ? this.adShowing : this.readAd();
  }

  /** Re-read the ad class now (MutationObserver callbacks are async). */
  checkAd(): void {
    const now = this.readAd();
    if (now === this.adShowing) return;
    this.adShowing = now;
    if (now) {
      this.restoreVolume();
      this.h.onAdStart?.();
    } else {
      this.h.onAdEnd?.();
    }
  }

  /** Current duck multiplier (1 = full volume). */
  duckFactor(): number { return this.level; }

  /** The user's volume as AutoDub sees it. */
  getUserVolume(): number { return this.userVolume; }

  // ---------------- internals ----------------

  private readAd(): boolean {
    const p = this.player;
    return !!p && AD_CLASSES.some((c) => p.classList.contains(c));
  }

  private rampTo(target: number, ms: number): void {
    this.stopRamp();
    const from = this.level;
    if (Math.abs(from - target) < 1e-4) return;
    const steps = Math.max(1, Math.round(ms / STEP_MS));
    let i = 0;
    this.ramp = setInterval(() => {
      i++;
      this.apply(from + ((target - from) * i) / steps);
      if (i >= steps) this.stopRamp();
    }, STEP_MS);
  }

  private stopRamp(): void {
    if (this.ramp) clearInterval(this.ramp);
    this.ramp = null;
  }

  private apply(level: number): void {
    this.level = level;
    if (this.gainSink) {
      try { this.gainSink(level); return; } catch { this.gainSink = null; }
    }
    this.writeVolume(this.userVolume * level);
  }

  private writeVolume(v: number): void {
    const val = clamp01(v);
    this.lastSet = val;
    try { this.video.volume = val; } catch { /* ignore */ }
  }

  private onVolumeChange(): void {
    const v = this.video.volume;
    if (this.lastSet != null && Math.abs(v - this.lastSet) < 0.005) return; // our own write
    // Someone else wrote the volume (the user's slider, or YouTube's player resetting it).
    // That value is the new baseline; if we are ducked, re-apply the duck on top of it
    // (YouTube resets video.volume on its own, which used to un-duck the original audio).
    this.stopRamp();
    this.userVolume = clamp01(v);
    this.lastSet = null;
    if (this.gainSink || this.level >= 1) return;
    if (this.reapply) return;
    this.reapply = setTimeout(() => {
      this.reapply = null;
      if (this.level < 1 && !this.gainSink) this.writeVolume(this.userVolume * this.level);
    }, 0);
  }

  private reapply: ReturnType<typeof setTimeout> | null = null;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/** Calls `cb` on yt-navigate-finish and popstate with the new URL. Returns unsubscribe. */
export function onNavigate(cb: (url: string) => void): () => void {
  let last = '';
  const fire = () => {
    const url = location.href;
    if (url === last) return;
    last = url;
    try { cb(url); } catch (e) { console.warn('[autodub] navigate handler failed', e); }
  };
  const nav = () => fire();
  document.addEventListener('yt-navigate-finish', nav);
  window.addEventListener('popstate', nav);
  return () => {
    document.removeEventListener('yt-navigate-finish', nav);
    window.removeEventListener('popstate', nav);
  };
}
