// AutoDub settings + secrets in chrome.storage.local (DESIGN_SPEC §7, §8). Owner: A.
// getSecrets / saveSecrets: service worker + popup ONLY. Never import them from src/content/**.
import type { EngineId, Lang, Secrets, Settings } from './types';

export const LANGS: readonly Lang[] = ['fr', 'ar', 'en', 'es', 'tr'] as const;

export interface LangInfo { code: Lang; name: string; native: string; bcp47: string; rtl: boolean }
export const LANG_INFO: Readonly<Record<Lang, LangInfo>> = {
  fr: { code: 'fr', name: 'French', native: 'Français', bcp47: 'fr-FR', rtl: false },
  ar: { code: 'ar', name: 'Arabic', native: 'العربية', bcp47: 'ar-SA', rtl: true },
  en: { code: 'en', name: 'English', native: 'English', bcp47: 'en-US', rtl: false },
  es: { code: 'es', name: 'Spanish', native: 'Español', bcp47: 'es-ES', rtl: false },
  tr: { code: 'tr', name: 'Turkish', native: 'Türkçe', bcp47: 'tr-TR', rtl: false },
};

export const ENGINES: readonly EngineId[] = ['webspeech', 'openai', 'elevenlabs'] as const;

/** chrome.storage.local keys (§7). */
export const STORAGE_KEYS = {
  settings: 'settings',
  secrets: 'secrets',
  feedback: 'feedback',
  stats: 'stats',
  onboarded: 'onboarded',
} as const;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: false,
  targetLang: 'fr',
  engine: 'webspeech',
  voiceByLang: {},
  duckLevel: 0.1,
  holdDuck: true,
  continuous: true,
  dubVolume: 1,
  voiceSpeed: 1,
  showBadge: true,
  showSubtitles: false,
  translateModel: 'gpt-4o-mini',
  matchSpeakerGender: true,
});

export const VOICE_SPEED_MIN = 0.75;
export const VOICE_SPEED_MAX = 1.3;

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/** Merge stored (possibly partial/invalid) data over defaults; clamps numbers, drops unknown values. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  const voiceByLang: Partial<Record<Lang, string>> = {};
  if (r.voiceByLang && typeof r.voiceByLang === 'object') {
    for (const [k, v] of Object.entries(r.voiceByLang as Record<string, unknown>)) {
      if ((LANGS as readonly string[]).includes(k) && typeof v === 'string' && v) voiceByLang[k as Lang] = v;
    }
  }
  return {
    enabled: bool(r.enabled, d.enabled),
    targetLang: (LANGS as readonly unknown[]).includes(r.targetLang) ? (r.targetLang as Lang) : d.targetLang,
    engine: (ENGINES as readonly unknown[]).includes(r.engine) ? (r.engine as EngineId) : d.engine,
    voiceByLang,
    duckLevel: clamp(r.duckLevel, 0, 1, d.duckLevel),
    holdDuck: typeof r.holdDuck === 'boolean' ? r.holdDuck : d.holdDuck,
    continuous: typeof r.continuous === 'boolean' ? r.continuous : d.continuous,
    dubVolume: clamp(r.dubVolume, 0, 1, d.dubVolume),
    voiceSpeed: clamp(r.voiceSpeed, VOICE_SPEED_MIN, VOICE_SPEED_MAX, d.voiceSpeed),
    showBadge: bool(r.showBadge, d.showBadge),
    showSubtitles: bool(r.showSubtitles, d.showSubtitles),
    translateModel: typeof r.translateModel === 'string' && r.translateModel.trim() ? r.translateModel.trim() : d.translateModel,
    matchSpeakerGender: bool(r.matchSpeakerGender, d.matchSpeakerGender),
  };
}

/** Read settings (defaults merged in). */
export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return normalizeSettings(got[STORAGE_KEYS.settings]);
}

/** Merge a patch into stored settings; returns the saved result. `voiceByLang` is merged per language. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await loadSettings();
  const next = normalizeSettings({
    ...cur,
    ...patch,
    voiceByLang: { ...cur.voiceByLang, ...(patch.voiceByLang ?? {}) },
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

/** Subscribe to settings changes from any context. Returns an unsubscribe function. */
export function onSettingsChanged(cb: (s: Settings, prev: Settings) => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
    const c = changes[STORAGE_KEYS.settings];
    cb(normalizeSettings(c.newValue), normalizeSettings(c.oldValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** SW + popup only. Read API keys. */
export async function getSecrets(): Promise<Secrets> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.secrets);
  const raw = got[STORAGE_KEYS.secrets] as Partial<Secrets> | undefined;
  const out: Secrets = {};
  if (raw && typeof raw.openaiKey === 'string' && raw.openaiKey) out.openaiKey = raw.openaiKey;
  if (raw && typeof raw.elevenKey === 'string' && raw.elevenKey) out.elevenKey = raw.elevenKey;
  return out;
}

/** SW + popup only. Merge keys; a key set to undefined or '' is removed. Never logs values. */
export async function saveSecrets(patch: Partial<Secrets>): Promise<void> {
  const cur = await getSecrets();
  const next: Secrets = { ...cur };
  for (const k of ['openaiKey', 'elevenKey'] as const) {
    if (!(k in patch)) continue;
    const v = patch[k]?.trim();
    if (v) next[k] = v;
    else delete next[k];
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.secrets]: next });
}
