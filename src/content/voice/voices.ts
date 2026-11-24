// Voice listing, ranking and gender match (§4). Owner: B.
import type { EngineId, Gender, Lang, VoiceInfo } from '../../shared/types';
import { loadSettings } from '../../shared/settings';
import { NEURAL_READY_KEY, neuralVoicesFor } from './neural-catalog';

export type { VoiceInfo };

// ---------------------------------------------------------------- gender table

/**
 * Known voice first names → gender (macOS system/Siri voices, Chrome-listed OS voices, Microsoft voices).
 * Keys are lower-case and accent-free. Names are unique enough across languages to share one table.
 */
const NAME_GENDER: Readonly<Record<string, 'male' | 'female'>> = {
  // fr
  thomas: 'male', amelie: 'female', audrey: 'female', aurelie: 'female', marie: 'female', nicolas: 'male',
  jacques: 'male', denise: 'female', henri: 'male', eloise: 'female', sylvie: 'female', antoine: 'male', jean: 'male',
  // ar
  maged: 'male', majed: 'male', laila: 'female', tarik: 'male', mariam: 'female', mona: 'female', hamed: 'male',
  zariyah: 'female', amira: 'female', hoda: 'female', naayf: 'male', salma: 'female', shakir: 'male', fatima: 'female',
  // tr
  yelda: 'female', cem: 'male', seda: 'female', filiz: 'female', ahmet: 'male', emel: 'female',
  // es
  jorge: 'male', monica: 'female', paulina: 'female', juan: 'male', diego: 'male', marisol: 'female', soledad: 'female',
  angelica: 'female', isabela: 'female', carlos: 'male', francisca: 'female', esperanza: 'female', paloma: 'female',
  pablo: 'male', elvira: 'female', alvaro: 'male', dalia: 'female', helena: 'female', laura: 'female',
  // en
  daniel: 'male', samantha: 'female', alex: 'male', karen: 'female', moira: 'female', fred: 'male', tom: 'male',
  ava: 'female', allison: 'female', victoria: 'female', susan: 'female', tessa: 'female', fiona: 'female',
  veena: 'female', rishi: 'male', serena: 'female', oliver: 'male', arthur: 'male', martha: 'female', evan: 'male',
  nathan: 'male', joelle: 'female', noelle: 'female', zoe: 'female', nicky: 'female', aaron: 'male', ralph: 'male',
  kathy: 'female', junior: 'male', agnes: 'female', vicki: 'female', lee: 'male', gordon: 'male', catherine: 'female',
  aria: 'female', guy: 'male', jenny: 'female', ryan: 'male', sonia: 'female', libby: 'female', mark: 'male',
  david: 'male', zira: 'female', hazel: 'female', george: 'male', susie: 'female', james: 'male',
  // macOS Eloquence voices (all languages)
  eddy: 'male', flo: 'female', grandma: 'female', grandpa: 'male', reed: 'male', rocko: 'male', sandy: 'female',
  shelley: 'female',
};

/** macOS novelty voices: never offered (kids app; unintelligible as a dub). */
const NOVELTY = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'good news', 'jester', 'organ', 'pipe organ',
  'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox', 'deranged', 'hysterical', 'princess', 'bruce',
]);
/** Eloquence voices: robotic, ranked low. */
const ELOQUENCE = new Set(['eddy', 'flo', 'grandma', 'grandpa', 'reed', 'rocko', 'sandy', 'shelley']);

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (name: string): string[] => fold(name).split(/[^a-z]+/).filter(Boolean);

/** Gender from a voice name: "Female"/"Male" words, then Google → unknown, then the name table. */
export function genderFromName(name: string): Gender {
  const t = tokens(name);
  if (t.includes('female') || t.includes('woman')) return 'female';
  if (t.includes('male') || t.includes('man')) return 'male';
  if (t[0] === 'google') return 'unknown';
  for (const tok of t) {
    if (tok === 'microsoft' || tok === 'online') continue;
    const g = NAME_GENDER[tok];
    if (g) return g;
  }
  return 'unknown';
}

const PRIMARY_REGION: Record<Lang, string> = { fr: 'fr-fr', ar: 'ar-sa', en: 'en-us', es: 'es-es', tr: 'tr-tr' };
const normTag = (tag: string): string => tag.replace(/_/g, '-').toLowerCase();
const matchesLang = (tag: string, lang: Lang): boolean => {
  const t = normTag(tag);
  return t === lang || t.startsWith(lang + '-');
};
const isNovelty = (name: string): boolean => NOVELTY.has(fold(name).replace(/\s*\(.*\)\s*$/, '').trim());

/** Quality score for a Web Speech voice (higher = better). Exported for tests. */
export function rankVoice(v: Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'default'>, lang: Lang): number {
  return 10 + voiceTier(v.name) + (normTag(v.lang) === PRIMARY_REGION[lang] ? 5 : 0) + (v.default ? 1 : 0);
}

/**
 * Quality tier from the name (v1.1): Premium 50 > Natural/Neural 45 > Enhanced 40 > Google 30 > Siri 25 > compact 0 > Eloquence −8.
 * Gaps (≥ 5) are wider than the region bonus (+5, e.g. fr-FR over fr-CA), so the region only breaks ties inside a tier.
 */
export function voiceTier(name: string): number {
  const n = fold(name);
  if (/\bpremium\b/.test(n)) return 50;
  if (/\b(natural|neural)\b/.test(n)) return 45;
  if (/\benhanced\b/.test(n)) return 40;
  if (/^google\b/.test(n)) return 30;
  if (/\bsiri\b/.test(n)) return 25;
  if (ELOQUENCE.has(tokens(name)[0] ?? '')) return -8;
  return 0;
}

/** True when a Premium/Enhanced/Natural (or Siri) voice is installed: else the popup suggests downloading one. */
export function hasHighQualityVoice(voices: readonly Pick<VoiceInfo, 'name'>[]): boolean {
  return voices.some((v) => voiceTier(v.name) >= 25 && !/^google\b/.test(fold(v.name)));
}

/** macOS voices worth downloading per language (popup hint; names as shown in "Manage voices"). */
export const MAC_HQ_VOICES: Readonly<Record<Lang, { female: string; male: string }>> = {
  fr: { female: 'Audrey (Premium)', male: 'Thomas (Enhanced)' },
  en: { female: 'Ava (Premium)', male: 'Evan (Enhanced)' },
  es: { female: 'Mónica (Enhanced)', male: 'Jorge (Enhanced)' },
  ar: { female: 'Laila', male: 'Majed (Enhanced)' },
  tr: { female: 'Yelda (Enhanced)', male: 'Cem' },
};

// ---------------------------------------------------------------- Web Speech voices

let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

function synth(): SpeechSynthesis | undefined {
  return typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined;
}

/** All Web Speech voices; waits for `voiceschanged` up to `timeoutMs` (Chrome returns [] at first). */
export function loadWebVoices(timeoutMs = 3000): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const now = s.getVoices();
  if (now.length) return Promise.resolve(now);
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.removeEventListener?.('voiceschanged', onChange);
      const v = s.getVoices();
      voicesPromise = null; // next call re-reads (voices can change at runtime)
      resolve(v);
    };
    const onChange = () => { if (s.getVoices().length) finish(); };
    const timer = setTimeout(finish, timeoutMs);
    s.addEventListener?.('voiceschanged', onChange);
  });
  return voicesPromise;
}

/** Synchronous lookup of a loaded Web Speech voice by voiceURI (or name). */
export function findWebVoice(id: string | undefined): SpeechSynthesisVoice | undefined {
  if (!id) return undefined;
  const all = synth()?.getVoices() ?? [];
  return all.find((v) => v.voiceURI === id) ?? all.find((v) => v.name === id);
}

/** Best loaded Web Speech voice for `lang` (sync; used when no voice was chosen). */
export function bestWebVoiceSync(lang: Lang): SpeechSynthesisVoice | undefined {
  const best = rankWebVoices(synth()?.getVoices() ?? [], lang)[0];
  return best ? findWebVoice(best.id) : undefined;
}

/** Convert + rank Web Speech voices for `lang`. Pure; exported for tests. */
export function rankWebVoices(all: readonly SpeechSynthesisVoice[], lang: Lang): VoiceInfo[] {
  return all
    .filter((v) => matchesLang(v.lang, lang) && !isNovelty(v.name))
    .map((v): VoiceInfo => ({
      id: v.voiceURI || v.name,
      name: v.name,
      lang: v.lang,
      engine: 'webspeech',
      gender: genderFromName(v.name),
      quality: rankVoice(v, lang),
    }))
    .sort((a, b) => b.quality - a.quality || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- API voices

/** OpenAI TTS voices (multilingual; gender = how they usually sound). Order = default ranking. */
export const OPENAI_VOICES: readonly { id: string; gender: Gender }[] = [
  { id: 'coral', gender: 'female' }, { id: 'nova', gender: 'female' }, { id: 'shimmer', gender: 'female' },
  { id: 'sage', gender: 'female' }, { id: 'marin', gender: 'female' },
  { id: 'echo', gender: 'male' }, { id: 'onyx', gender: 'male' }, { id: 'ash', gender: 'male' },
  { id: 'ballad', gender: 'male' }, { id: 'verse', gender: 'male' }, { id: 'fable', gender: 'male' },
  { id: 'cedar', gender: 'male' }, { id: 'alloy', gender: 'unknown' },
];

/** ElevenLabs default (premade) voices, multilingual with eleven_flash_v2_5. */
export const ELEVEN_VOICES: readonly { id: string; name: string; gender: Gender }[] = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', gender: 'female' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', gender: 'female' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', gender: 'female' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', gender: 'female' },
  { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', gender: 'female' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura', gender: 'female' },
  { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', gender: 'female' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', gender: 'male' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', gender: 'male' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', gender: 'male' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', gender: 'male' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', gender: 'male' },
  { id: 'cjVigY5qzO86Huf0OWal', name: 'Eric', gender: 'male' },
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', gender: 'male' },
  { id: 'bIHbv24MWmeRgasZH58o', name: 'Will', gender: 'male' },
];

function apiVoices(engine: 'openai' | 'elevenlabs', lang: Lang): VoiceInfo[] {
  const src = engine === 'openai'
    ? OPENAI_VOICES.map((v) => ({ id: v.id, name: v.id[0].toUpperCase() + v.id.slice(1), gender: v.gender }))
    : ELEVEN_VOICES;
  return src.map((v, i) => ({ id: v.id, name: v.name, lang, engine, gender: v.gender, quality: 100 - i }));
}

// ---------------------------------------------------------------- neural voices (v1.1, Piper on this computer)

/** Models already downloaded (written by the service worker in chrome.storage.local). */
export async function neuralReadyModels(): Promise<string[]> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return [];
    const got = await chrome.storage.local.get(NEURAL_READY_KEY);
    const v = got[NEURAL_READY_KEY];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Added to a neural voice's quality once its model is downloaded (ranks first; popup shows "not downloaded" below it). */
export const NEURAL_READY_BONUS = 1000;

/** v1.2.2: recommended voices (Siwis, Pierre) always rank above others, even before they are downloaded
 * (picking one starts its download; Web Speech fills in meanwhile). Owners who had Tom move to Pierre on reload. */
export const NEURAL_RECOMMENDED_BONUS = 2000;

/** Neural voices for `lang` as VoiceInfo; recommended first, then downloaded. Pure; exported for tests. */
export function neuralVoiceInfos(lang: Lang, ready: readonly string[] = []): VoiceInfo[] {
  return neuralVoicesFor(lang)
    .map((v): VoiceInfo => ({
      id: v.id, name: v.name, lang: v.bcp47, engine: 'neural', gender: v.gender,
      quality: v.rank + (v.recommended ? NEURAL_RECOMMENDED_BONUS : 0) + (ready.includes(v.model) ? NEURAL_READY_BONUS : 0),
    }))
    .sort((a, b) => b.quality - a.quality || a.name.localeCompare(b.name));
}

/** Default API voice (sync). */
export function defaultApiVoice(engine: 'openai' | 'elevenlabs'): string {
  return engine === 'openai' ? OPENAI_VOICES[0].id : ELEVEN_VOICES[0].id;
}

// ---------------------------------------------------------------- public API

/** Voices for `lang`, quality-ranked (Natural/Neural/Google/Premium/Enhanced first). Default engine: webspeech. [] if none. */
export async function listVoices(lang: Lang, engine: EngineId = 'webspeech'): Promise<VoiceInfo[]> {
  if (engine === 'neural') return neuralVoiceInfos(lang, await neuralReadyModels());
  if (engine !== 'webspeech') return apiVoices(engine, lang);
  return rankWebVoices(await loadWebVoices(), lang);
}

/** Best voice for `lang` (the user's chosen voice when it exists), or null (→ NO_VOICE). */
export async function pickBestVoice(lang: Lang, engine: EngineId = 'webspeech', preferredId?: string): Promise<VoiceInfo | null> {
  const voices = await listVoices(lang, engine);
  const pref = preferredId ?? (await userVoice(lang));
  return voices.find((v) => v.id === pref) ?? voices[0] ?? null;
}

/** Which genders are available (popup: "only female voices installed"). Unknown counts as female (§4). */
export function gendersOf(voices: readonly VoiceInfo[]): { male: boolean; female: boolean } {
  return { male: voices.some((v) => v.gender === 'male'), female: voices.some((v) => v.gender !== 'male') };
}

/** Effective gender for matching: unknown (e.g. Google voices) is treated as female (§4). */
const effGender = (g: Gender): 'male' | 'female' => (g === 'male' ? 'male' : 'female');

/** Choose a voice of `gender` from a ranked list, honouring the preferred voice for its own gender. Pure. */
export function chooseVoice(voices: readonly VoiceInfo[], gender: Gender, preferredId?: string): VoiceInfo | null {
  if (!voices.length) return null;
  const pref = voices.find((v) => v.id === preferredId);
  if (gender === 'unknown') return pref ?? voices[0];
  if (pref && effGender(pref.gender) === gender) return pref;
  const same = voices.filter((v) => effGender(v.gender) === gender);
  const exact = same.filter((v) => v.gender === gender);
  const pool = exact.length ? exact : same;
  if (!pool.length) return pref ?? voices[0];
  if (pref) {
    const sameRegion = pool.find((v) => normTag(v.lang) === normTag(pref.lang));
    if (sameRegion) return sameRegion;
  }
  return pool[0];
}

const stable = new Map<string, VoiceInfo>();

/** Forget the per-gender choices (new session / voice setting changed). */
export function resetVoiceChoices(): void {
  stable.clear();
}

/** Voice of `gender` for `lang`; stable per (engine, lang, gender, chosen voice) for the session; falls back to best voice. */
export async function pickVoiceFor(lang: Lang, gender: Gender, engine: EngineId = 'webspeech', preferredId?: string): Promise<VoiceInfo | null> {
  const pref = preferredId ?? (await userVoice(lang));
  const key = `${engine}|${lang}|${gender}|${pref ?? ''}`;
  const voices = await listVoices(lang, engine);
  const hit = stable.get(key);
  if (hit && voices.some((v) => v.id === hit.id)) return hit;
  const v = chooseVoice(voices, gender, pref);
  if (v) stable.set(key, v);
  return v;
}

async function userVoice(lang: Lang): Promise<string | undefined> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return undefined;
    return (await loadSettings()).voiceByLang[lang];
  } catch {
    return undefined;
  }
}

/** Help text for NO_VOICE (§4). */
export const NO_VOICE_HELP =
  'No voice installed for this language. On Mac: System Settings → Accessibility → Spoken Content → System voice → Manage voices.';
