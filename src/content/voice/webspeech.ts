// Free browser voices via speechSynthesis (§4). Owner: B.
import type { Lang, Line } from '../../shared/types';
import type { Prepared, PlayHandle, TtsEngine } from './engine';

/** Web Speech engine: waits voiceschanged (≤ 3 s), keeps utterance refs, re-applies voice per utterance, watchdog est*1.6+1500 ms, splits > 180 chars. */
export class WebSpeechEngine implements TtsEngine {
  readonly id = 'webspeech' as const;

  /** No network; resolves immediately with a text-only Prepared. */
  async prepare(line: Line, lang: Lang, voice?: string): Promise<Prepared> {
    void line; void lang; void voice;
    throw new Error('TODO B');
  }

  /** Speak now at `rate` and `volume` (0..1). */
  play(p: Prepared, rate: number, volume: number): PlayHandle {
    void p; void rate; void volume;
    throw new Error('TODO B');
  }

  /** Cancel everything queued or speaking. */
  stopAll(): void {
    // TODO B
  }
}
