// In-player UI in Shadow DOM: Dub button, "AI dub" badge, thumbs, subtitles, toasts (§6). Owner: D.
import type { DubStatus, Lang, Line, Settings } from '../../shared/types';

/** What the UI needs from the session (DubSession + content/index.ts provide it). */
export interface PlayerUIApi {
  getStatus(): DubStatus;
  onStatus(cb: (s: DubStatus) => void): () => void;
  toggle(on?: boolean): Promise<DubStatus>;
  currentLine(): Line | null;
  getSettings(): Settings;
  /** Persist a settings change (e.g. hiding the badge). */
  setSettings?(patch: Partial<Settings>): Promise<void>;
  /** Called on thumbs up/down for the current line (session adds rate/overflow then saveFeedback). */
  onThumb?(line: Line, up: boolean): void;
}

export interface PlayerUI {
  update(status: DubStatus): void;
  showToast(message: string, kind?: 'info' | 'warn' | 'error'): void;
  /** Show translated subtitle text (null hides). RTL for Arabic. */
  showSubtitle(text: string | null, lang?: Lang): void;
  destroy(): void;
}

/** Mount the Dub button into .ytp-right-controls (before CC) and overlays into the player. */
export function mountPlayerUI(api: PlayerUIApi, player?: HTMLElement | null): PlayerUI {
  void api; void player;
  throw new Error('TODO D');
}
