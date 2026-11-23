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

/** Watches <video> + #movie_player (ad-showing via MutationObserver) and ramps volume for ducking. */
export class PlayerWatcher {
  constructor(video: HTMLVideoElement, player: HTMLElement | null, handlers: PlayerHandlers) {
    void video; void player; void handlers;
  }

  start(): void {
    throw new Error('TODO C');
  }

  /** Remove listeners and restore the original volume. */
  stop(): void {
    // TODO C
  }

  /** Ramp original audio to `level` (0..1 of user volume) or back (on=false). */
  duck(on: boolean, level?: number): void {
    void on; void level;
    throw new Error('TODO C');
  }

  /** Restore the user's original volume immediately. */
  restoreVolume(): void {
    // TODO C
  }

  isAdShowing(): boolean {
    return false; // TODO C
  }
}

/** Calls `cb` on yt-navigate-finish and popstate with the new URL. Returns unsubscribe. */
export function onNavigate(cb: (url: string) => void): () => void {
  void cb;
  return () => {}; // TODO C
}
