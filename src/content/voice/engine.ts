// Voice engine contract (§4). Owner: B.
import type { EngineId, Lang, Line } from '../../shared/types';
import { WebSpeechEngine } from './webspeech';
import { AudioEngine, type AudioEngineOptions } from './audio';

/** A line ready to play. API engines carry a Blob URL and decoded duration; WebSpeech carries text only. */
export interface Prepared {
  line: Line;
  lang: Lang;
  engine: EngineId;
  /** Voice used (voiceURI or API voice id). */
  voice?: string;
  /** Blob URL of the audio (API engines). */
  url?: string;
  /** Real duration at rate 1 in ms, when known (API engines). */
  knownMs?: number;
}

export type PlayEnd = 'ended' | 'stopped' | 'error';

/** Handle on one playing line. */
export interface PlayHandle {
  /** Resolves when playback ends, is stopped, or fails. Never rejects. */
  done: Promise<PlayEnd>;
  stop(): void;
  pause(): void;
  resume(): void;
  /** Change rate mid-line (player ratechange); may be a no-op for WebSpeech. */
  setRate?(rate: number): void;
  setVolume?(volume: number): void;
}

export interface TtsEngine {
  id: EngineId;
  /** API engines: fetch + cache bytes via SW; WebSpeech: no-op. `voice` overrides the engine's default voice. */
  prepare(line: Line, lang: Lang, voice?: string): Promise<Prepared>;
  play(p: Prepared, rate: number, volume: number): PlayHandle;
  stopAll(): void;
  /** Release resources (Blob URLs) at session end. Optional. */
  dispose?(): void;
}

/** Factory: 'webspeech' → WebSpeechEngine, 'openai' | 'elevenlabs' → AudioEngine (opts: onFallback, speed, send). */
export function createEngine(id: EngineId, opts?: AudioEngineOptions): TtsEngine {
  return id === 'webspeech' ? new WebSpeechEngine() : new AudioEngine(id, opts);
}
