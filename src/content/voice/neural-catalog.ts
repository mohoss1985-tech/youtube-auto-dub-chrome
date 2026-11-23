// Piper neural voices (free, run on this computer). Owner: P (v1.1).
// Pure data + helpers: imported by the content script, the service worker, the offscreen document and the popup.
// Models are DATA (.onnx weights + .json config) downloaded once from huggingface.co (rhasspy/piper-voices),
// cached in the extension origin (Cache API). All code (JS + .wasm) ships inside the extension.
import type { Gender, Lang } from '../../shared/types';

export interface NeuralVoice {
  /** Voice id used in settings / messages: model key, plus `#speaker` for multi-speaker models. */
  id: string;
  /** Piper model key (one .onnx file), e.g. fr_FR-siwis-medium. */
  model: string;
  /** Speaker name inside a multi-speaker model (speaker_id_map key). */
  speaker?: string;
  lang: Lang;
  /** BCP-47 tag of the voice. */
  bcp47: string;
  /** Display name. */
  name: string;
  gender: Exclude<Gender, 'unknown'>;
  /** Licence of the voice's training data (model card). */
  license: string;
  /** Download size of the .onnx in MB. */
  sizeMB: number;
  /** Higher = better (ranking inside a language). */
  rank: number;
  /** One of the two voices downloaded by the popup's "Download" button for this language. */
  recommended?: boolean;
}

/** HuggingFace repo with the official Piper voices. `resolve/main` serves files with CORS `*`. */
export const PIPER_HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/** chrome.storage.local key: ids of models fully downloaded (written by the service worker). */
export const NEURAL_READY_KEY = 'neuralReady';

/** Cache API bucket (extension origin) holding the downloaded models. */
export const NEURAL_CACHE = 'autodub-piper-v1';

export const NEURAL_VOICES: readonly NeuralVoice[] = [
  // French (priority). siwis = clearest French female Piper voice; tom = natural male (44.1 kHz).
  { id: 'fr_FR-siwis-medium', model: 'fr_FR-siwis-medium', lang: 'fr', bcp47: 'fr-FR', name: 'Siwis', gender: 'female', license: 'CC BY 4.0 (SIWIS corpus)', sizeMB: 63, rank: 100, recommended: true },
  { id: 'fr_FR-tom-medium', model: 'fr_FR-tom-medium', lang: 'fr', bcp47: 'fr-FR', name: 'Tom', gender: 'male', license: 'AGPL-3.0 (model by Tjiho)', sizeMB: 64, rank: 95, recommended: true },
  { id: 'fr_FR-upmc-medium#jessica', model: 'fr_FR-upmc-medium', speaker: 'jessica', lang: 'fr', bcp47: 'fr-FR', name: 'Jessica', gender: 'female', license: 'CC BY-SA 4.0 (UPMC corpus)', sizeMB: 77, rank: 80 },
  { id: 'fr_FR-upmc-medium#pierre', model: 'fr_FR-upmc-medium', speaker: 'pierre', lang: 'fr', bcp47: 'fr-FR', name: 'Pierre', gender: 'male', license: 'CC BY-SA 4.0 (UPMC corpus)', sizeMB: 77, rank: 78 },
  // English
  { id: 'en_US-hfc_female-medium', model: 'en_US-hfc_female-medium', lang: 'en', bcp47: 'en-US', name: 'HFC Female', gender: 'female', license: 'CC BY-NC-SA 4.0 (personal use)', sizeMB: 63, rank: 90, recommended: true },
  { id: 'en_US-ryan-medium', model: 'en_US-ryan-medium', lang: 'en', bcp47: 'en-US', name: 'Ryan', gender: 'male', license: 'CC BY-NC-SA 4.0 (personal use)', sizeMB: 63, rank: 90, recommended: true },
  // Spanish: sharvard = one model, two speakers (M + F).
  { id: 'es_ES-sharvard-medium#F', model: 'es_ES-sharvard-medium', speaker: 'F', lang: 'es', bcp47: 'es-ES', name: 'Sharvard F', gender: 'female', license: 'CC BY 3.0', sizeMB: 77, rank: 90, recommended: true },
  { id: 'es_ES-davefx-medium', model: 'es_ES-davefx-medium', lang: 'es', bcp47: 'es-ES', name: 'Davefx', gender: 'male', license: 'CC0', sizeMB: 63, rank: 90, recommended: true },
  { id: 'es_ES-sharvard-medium#M', model: 'es_ES-sharvard-medium', speaker: 'M', lang: 'es', bcp47: 'es-ES', name: 'Sharvard M', gender: 'male', license: 'CC BY 3.0', sizeMB: 77, rank: 80 },
  // Arabic / Turkish: Piper has one male voice each.
  { id: 'ar_JO-kareem-medium', model: 'ar_JO-kareem-medium', lang: 'ar', bcp47: 'ar-JO', name: 'Kareem', gender: 'male', license: 'see model card (Arabic speech corpus)', sizeMB: 63, rank: 80, recommended: true },
  { id: 'tr_TR-dfki-medium', model: 'tr_TR-dfki-medium', lang: 'tr', bcp47: 'tr-TR', name: 'DFKI', gender: 'male', license: 'CC BY-NC-SA 4.0 (personal use)', sizeMB: 63, rank: 80, recommended: true },
];

/** Catalog entry for a voice id (or a bare model key). */
export function neuralVoice(id: string | undefined): NeuralVoice | undefined {
  if (!id) return undefined;
  return NEURAL_VOICES.find((v) => v.id === id) ?? NEURAL_VOICES.find((v) => v.model === id);
}

/** Voices for a language, best first. */
export function neuralVoicesFor(lang: Lang): NeuralVoice[] {
  return NEURAL_VOICES.filter((v) => v.lang === lang).sort((a, b) => b.rank - a.rank);
}

/** Models the popup downloads for a language (recommended male + female). */
export function recommendedModels(lang: Lang): string[] {
  return [...new Set(neuralVoicesFor(lang).filter((v) => v.recommended).map((v) => v.model))];
}

/** Default neural voice for a language (recommended female first, as Web Speech's unknown → female). */
export function defaultNeuralVoice(lang: Lang, gender: Gender = 'female'): NeuralVoice | undefined {
  const list = neuralVoicesFor(lang);
  return list.find((v) => v.recommended && v.gender === gender) ?? list.find((v) => v.recommended) ?? list[0];
}

/** `fr_FR-siwis-medium` → `fr/fr_FR/siwis/medium/fr_FR-siwis-medium`. */
export function modelPath(model: string): string {
  const m = /^([a-z]{2,3})_([A-Z]{2})-(.+)-(x_low|low|medium|high)$/.exec(model);
  if (!m) throw new Error(`Bad Piper model key: ${model}`);
  const [, fam, region, name, quality] = m;
  return `${fam}/${fam}_${region}/${name}/${quality}/${model}`;
}

/** URLs of a model's weights and config. */
export function modelUrls(model: string, base = PIPER_HF_BASE): { onnx: string; json: string } {
  const p = `${base}/${modelPath(model)}`;
  return { onnx: `${p}.onnx`, json: `${p}.onnx.json` };
}
