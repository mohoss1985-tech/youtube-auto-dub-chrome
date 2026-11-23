// API voices (OpenAI / ElevenLabs) played via <audio> in the content script (§4, C1). Owner: B.
import type { Lang, Line } from '../../shared/types';
import type { Prepared, PlayHandle, TtsEngine } from './engine';

/** Audio engine: prepare sends TTS to the SW, base64 → Blob URL, decodes duration (knownMs); play uses one <audio> per line with playbackRate = rate. */
export class AudioEngine implements TtsEngine {
  readonly id: 'openai' | 'elevenlabs';

  constructor(id: 'openai' | 'elevenlabs') {
    this.id = id;
  }

  /** Fetch (or reuse cached) audio for the line. Throws DubError('ENGINE_ERROR' | 'NO_KEY' | 'TIMEOUT'). */
  async prepare(line: Line, lang: Lang, voice?: string): Promise<Prepared> {
    void line; void lang; void voice;
    throw new Error('TODO B');
  }

  /** Play prepared audio now. */
  play(p: Prepared, rate: number, volume: number): PlayHandle {
    void p; void rate; void volume;
    throw new Error('TODO B');
  }

  /** Stop all audio and revoke Blob URLs. */
  stopAll(): void {
    // TODO B
  }
}
