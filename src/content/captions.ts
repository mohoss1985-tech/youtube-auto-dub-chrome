// Caption track selection, json3 parsing, sentence merging. Owner: A.
import type { AudioTrackInfo, CaptionTrack, Cue, Json3, Lang, Line, PlayerResponse } from '../shared/types';

/** Prefer human (kind !== 'asr') over ASR; within that prefer a track already in `target`. null if no tracks. */
export function pickTrack(tracks: CaptionTrack[], target: Lang): CaptionTrack | null {
  void tracks; void target;
  throw new Error('TODO A');
}

/** json3 → Cue[] (drop events without segs or only "\n"; end capped at next start). Seconds. */
export function parseJson3(json: Json3): Cue[] {
  void json;
  throw new Error('TODO A');
}

/** Join cues into sentences (punctuation / gap > 1.2 s / 180 chars / ~12 s; ASR: gap > 0.7 s or 120 chars). `asr` defaults to "no punctuation detected". */
export function mergeSentences(cues: Cue[], lang: string, opts?: { asr?: boolean }): Line[] {
  void cues; void lang; void opts;
  throw new Error('TODO A');
}

/** YouTube's alternative audio tracks (official / auto-dub) from the player response; [] if none. */
export function listAudioTracks(pr: PlayerResponse | null): AudioTrackInfo[] {
  void pr;
  return []; // TODO A
}
