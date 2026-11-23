// DubSession orchestrator: pipeline → prefetch → scheduler; status events (§5). Owner: C.
import type { DubStatus, Line, Settings } from '../shared/types';

export interface DubSessionOptions {
  videoId: string;
  settings: Settings;
  video?: HTMLVideoElement;
  player?: HTMLElement | null;
}

/** One dub run for one video. Created when the user turns dub on; stop() restores everything. */
export class DubSession {
  constructor(opts: DubSessionOptions) {
    void opts;
  }

  /** Run pipeline, prefetch 30 s ahead, start the scheduler. Resolves when dubbing starts or errors (status reflects which). */
  async start(): Promise<void> {
    throw new Error('TODO C');
  }

  /** Stop speech, restore volume, remove listeners. Idempotent. */
  stop(): void {
    // TODO C
  }

  /** Turn on/off (omit = toggle). */
  async toggle(on?: boolean): Promise<DubStatus> {
    void on;
    throw new Error('TODO C');
  }

  getStatus(): DubStatus {
    return { state: 'idle' }; // TODO C
  }

  /** Subscribe to status changes. Returns unsubscribe. */
  onStatus(cb: (s: DubStatus) => void): () => void {
    void cb;
    return () => {}; // TODO C
  }

  /** Line being spoken now, or null. */
  currentLine(): Line | null {
    return null; // TODO C
  }

  /** Apply changed settings live (volume, speed, voice, language → restart). */
  updateSettings(s: Settings): void {
    void s;
    // TODO C
  }
}
