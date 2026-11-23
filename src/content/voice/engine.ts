// Voice engine contract (§4). Owner: B.
import type { EngineId, Lang, Line } from '../../shared/types';
import { WebSpeechEngine } from './webspeech';
import { AudioEngine, type AudioEngineOptions } from './audio';
import { NeuralEngine } from './neural';

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

/**
 * Factory: 'webspeech' → WebSpeechEngine, 'openai' | 'elevenlabs' → AudioEngine (opts: onFallback, speed, send),
 * 'neural' → NeuralEngine (free Piper voices on this computer; opts.onFallback after repeated failures).
 */
export function createEngine(id: EngineId, opts?: AudioEngineOptions): TtsEngine {
  if (id === 'webspeech') return new WebSpeechEngine();
  if (id === 'neural') return new NeuralEngine({ onFallback: opts?.onFallback });
  return new AudioEngine(id, opts);
}
