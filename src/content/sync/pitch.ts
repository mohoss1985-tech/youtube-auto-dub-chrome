// Speaker gender from original-audio pitch (§5 SpeakerPitch). Owner: C.
import type { Gender, Line } from '../../shared/types';

/** WebAudio graph on the <video>: autocorrelation F0 every 50 ms; median F0 per line → gender (< 165 Hz male). Also owns ducking gain when the graph exists. */
export class SpeakerPitch {
  constructor(video: HTMLVideoElement) {
    void video;
  }

  /** Build the graph and start sampling. Returns false if WebAudio failed (then genderFor → 'unknown'). */
  start(): boolean {
    return false; // TODO C
  }

  /** Gender for a line from F0 over [start,end] and caption hints; 'unknown' if < 30 % voiced. */
  genderFor(line: Line): Gender {
    void line;
    return 'unknown'; // TODO C
  }

  /** Original-audio gain 0..1 (ducking) when the graph exists. */
  setGain(v: number): void {
    void v;
    // TODO C
  }

  /** Stop sampling; keep audio routed (a MediaElementSource cannot be detached). */
  stop(): void {
    // TODO C
  }
}
