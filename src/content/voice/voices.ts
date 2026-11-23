// Voice listing, ranking and gender match (§4). Owner: B.
import type { EngineId, Gender, Lang, VoiceInfo } from '../../shared/types';

export type { VoiceInfo };

/** Voices for `lang`, quality-ranked (Natural/Neural/Google/Premium/Enhanced first). Default engine: webspeech. [] if none. */
export async function listVoices(lang: Lang, engine?: EngineId): Promise<VoiceInfo[]> {
  void lang; void engine;
  return []; // TODO B
}

/** Best-ranked voice for `lang`, or null (→ NO_VOICE). */
export async function pickBestVoice(lang: Lang, engine?: EngineId): Promise<VoiceInfo | null> {
  void lang; void engine;
  return null; // TODO B
}

/** Voice of `gender` for `lang`; stable per (lang, gender) for the session; falls back to best voice. */
export async function pickVoiceFor(lang: Lang, gender: Gender, engine?: EngineId): Promise<VoiceInfo | null> {
  void lang; void gender; void engine;
  return null; // TODO B
}
