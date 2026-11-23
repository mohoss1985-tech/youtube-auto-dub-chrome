// Popup controller (DESIGN_SPEC §6). Owner: D.
// Talks to the active tab via GET_STATUS / DUB_TOGGLE / LIST_VOICES / TEST_VOICE and listens to STATUS.
// `popup.html?mock=<state>` renders a fixed mock state (screenshots, tests): see MOCK_STATES.
import type { DubErrorCode, DubStatus, EngineId, ErrorCode, Gender, Lang, NeuralModelState, Settings, VoiceInfo } from '../shared/types';
import {
  DEFAULT_SETTINGS, LANGS, LANG_INFO, VOICE_SPEED_MAX, VOICE_SPEED_MIN,
  getSecrets, loadSettings, normalizeSettings, saveSecrets, saveSettings,
} from '../shared/settings';
import { sendToSW, sendToTab, type MsgResponse } from '../shared/messages';
// B's pure voice helpers (Web Speech works in the popup too: it is an extension page).
import { MAC_HQ_VOICES, NEURAL_READY_BONUS, NO_VOICE_HELP, gendersOf, hasHighQualityVoice, listVoices as listVoicesB } from '../content/voice/voices';
import { neuralVoicesFor, recommendedModels } from '../content/voice/neural-catalog';

// ---------------------------------------------------------------- types

export type ApiEngine = 'openai' | 'elevenlabs';
/** Engines that need a key + host permission. */
export const isApiEngine = (e: EngineId): e is ApiEngine => e === 'openai' || e === 'elevenlabs';
/** Where the popup was opened: on a tab with our content script, on YouTube without it (needs reload), elsewhere. */
export type TabContext = 'loading' | 'youtube' | 'reload' | 'not-youtube';
/** Last 4 chars of each saved key (never the key itself). */
export interface KeyHints { openai?: string; elevenlabs?: string }

/** Everything the popup needs from the outside world. Real = chrome.*, mock = fixed data. */
export interface PopupBackend {
  loadSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  keyHints(): Promise<KeyHints>;
  saveKey(engine: ApiEngine, key: string | null): Promise<void>;
  connect(): Promise<{ context: TabContext; status: DubStatus }>;
  toggle(on: boolean): Promise<MsgResponse<{ status: DubStatus }>>;
  listVoices(lang: Lang, engine: EngineId): Promise<VoiceInfo[]>;
  testVoice(lang: Lang, engine: EngineId, voice: string): Promise<MsgResponse>;
  /** Must call chrome.permissions.request synchronously (user gesture). */
  requestHost(engine: ApiEngine): Promise<boolean>;
  removeHost(engine: ApiEngine): Promise<void>;
  onStatus(cb: (s: DubStatus) => void): void;
  reloadTab(): void;
  /** v1.1 neural voices: download state of `models`; `download` starts downloads first. */
  neuralStatus(models: string[], download?: string[]): Promise<NeuralModelState[]>;
  theme?: 'light' | 'dark';
  /** Mock only: open the Engine section at start. */
  engineOpen?: boolean;
}

export interface InitOptions { backend?: PopupBackend; mock?: string | null }

// ---------------------------------------------------------------- constants

const HOSTS: Record<ApiEngine, string> = {
  openai: 'https://api.openai.com/*',
  elevenlabs: 'https://api.elevenlabs.io/*',
};

const ENGINE_INFO: Record<EngineId, { name: string; short: string; sub: string; tag: string }> = {
  neural: { name: 'Neural voices', short: 'Neural (free)', sub: 'Free, on this computer · ~60 MB per voice', tag: 'Free' },
  webspeech: { name: 'Browser voices', short: 'Browser (free)', sub: 'Installed on this Mac · offline', tag: 'Free' },
  openai: { name: 'OpenAI', short: 'OpenAI', sub: 'Natural voices · your key', tag: '≈ $0.90 / h' },
  elevenlabs: { name: 'ElevenLabs', short: 'ElevenLabs', sub: 'Most natural · your key', tag: '≈ 25k credits / h' },
};

const COST_HINT: Record<ApiEngine, string> = {
  openai: 'Cost ≈ characters × price: 1 h of video ≈ 50,000 characters ≈ $0.90 (gpt-4o-mini-tts). Replays use the cache.',
  elevenlabs: 'Cost ≈ characters × price: 1 h of video ≈ 50,000 characters ≈ 25,000 credits (Flash, 0.5 credit per character).',
};

const KEY_PLACEHOLDER: Record<ApiEngine, string> = { openai: 'sk-…', elevenlabs: 'ElevenLabs API key' };

/** One short test line per language. */
export const TEST_LINES: Record<Lang, string> = {
  fr: 'Bonjour ! Voici comment sonne cette voix.',
  ar: 'مرحبًا! هكذا يبدو هذا الصوت.',
  en: 'Hello! This is how this voice sounds.',
  es: '¡Hola! Así suena esta voz.',
  tr: 'Merhaba! Bu ses böyle duyuluyor.',
};

/** macOS voices to suggest when a gender is missing (DESIGN_SPEC §4 table). */
const SUGGEST: Record<Lang, Record<'male' | 'female', string>> = {
  fr: { male: 'Thomas', female: 'Amélie' },
  ar: { male: 'Majed', female: 'Laila' },
  en: { male: 'Daniel', female: 'Samantha' },
  es: { male: 'Jorge', female: 'Mónica' },
  tr: { male: 'Cem', female: 'Yelda' },
};

const MAC_PATH = ['System Settings', 'Accessibility', 'Spoken Content', 'System voice', 'Manage voices…'];

// ---------------------------------------------------------------- icons (inline SVG, 24-unit, stroke)

const ICONS: Record<string, string> = {
  logo: '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  sliders: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  video: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="m22 8-5 4 5 4z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  tv: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2-5 5-5-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
};

export function icon(name: keyof typeof ICONS | string, cls = 'icon'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

// ---------------------------------------------------------------- helpers

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

const genderLabel = (g: Gender): string => (g === 'male' ? 'Male' : g === 'female' ? 'Female' : '');

/** Option label: "Amélie (Enhanced) · Female". */
export function voiceLabel(v: VoiceInfo, best: boolean): string {
  // "Amélie (Enhanced)" → "Amélie HD": keeps the gender visible in a 340-px popup.
  const name = v.name.replace(/\s*\((enhanced|premium|natural|neural)\)/i, ' HD').replace(/^Microsoft\s+|\s+Online.*$/g, '');
  const parts = [name];
  const g = genderLabel(v.gender);
  if (g) parts.push(g);
  if (v.engine === 'neural' && v.quality < NEURAL_READY_BONUS) parts.push('not downloaded');
  else if (best && !/ HD$/.test(name)) parts.push('Best');
  return parts.join(' · ');
}

/** Status line text + tone for the header. */
export function statusLine(status: DubStatus, context: TabContext, lang: Lang): { text: string; tone: string } {
  if (context === 'loading') return { text: 'Checking this tab…', tone: 'idle' };
  if (context === 'not-youtube') return { text: 'Not on a YouTube video', tone: 'idle' };
  if (context === 'reload') return { text: 'Reload the page to start', tone: 'warn' };
  switch (status.state) {
    case 'preparing': return { text: 'Preparing…', tone: 'busy' };
    case 'dubbing': return { text: `Dubbing into ${LANG_INFO[lang].name}`, tone: 'ok' };
    case 'paused-ad': return { text: 'Paused for ad', tone: 'warn' };
    case 'error': return { text: 'Error', tone: 'error' };
    default:
      if (status.error === 'NOT_WATCH_PAGE') return { text: 'Open a video to dub it', tone: 'idle' };
      return { text: 'Idle', tone: 'idle' };
  }
}

interface BannerSpec {
  tone: 'info' | 'warn' | 'error';
  icon: string;
  title: string;
  text?: string;
  progress?: number | 'indeterminate';
  actions?: { id: string; label: string; primary?: boolean }[];
}

/** Error code → plain message + one action (§6 "error with action"). */
export function errorBanner(code: ErrorCode | undefined, lang: Lang, message?: string): BannerSpec {
  const L = LANG_INFO[lang].name;
  switch (code) {
    case 'NO_CAPTIONS':
      return { tone: 'error', icon: 'alert', title: 'This video has no subtitles', text: 'AutoDub dubs from subtitles, so it can’t dub this one yet. Try another video.' };
    case 'NO_TRANSLATION':
      return {
        tone: 'error', icon: 'alert', title: `Can’t translate to ${L}`,
        text: 'YouTube and Chrome couldn’t translate these subtitles. An OpenAI key can.',
        actions: [{ id: 'open-engine', label: 'Add OpenAI key', primary: true }, { id: 'retry', label: 'Try again' }],
      };
    case 'RATE_LIMITED':
      return { tone: 'warn', icon: 'alert', title: 'YouTube is busy', text: 'Too many requests. Wait a minute, then try again.', actions: [{ id: 'retry', label: 'Try again', primary: true }] };
    case 'ENGINE_ERROR':
      return {
        tone: 'warn', icon: 'alert', title: 'Voice service failed', text: message || 'Switched to the free browser voice for this video. Check your key.',
        actions: [{ id: 'open-engine', label: 'Check key', primary: true }],
      };
    case 'NO_KEY':
      return { tone: 'warn', icon: 'key', title: 'Key missing', text: 'Add your API key, or switch back to free browser voices.', actions: [{ id: 'open-engine', label: 'Add key', primary: true }] };
    case 'NO_VOICE':
      return { tone: 'error', icon: 'alert', title: `No ${L} voice on this Mac`, text: NO_VOICE_HELP, actions: [{ id: 'retry', label: 'Try again', primary: true }] };
    case 'TIMEOUT':
    case 'NETWORK':
      return { tone: 'error', icon: 'alert', title: 'The page didn’t answer', text: 'Reload the YouTube page, then press Dub again.', actions: [{ id: 'reload', label: 'Reload page', primary: true }] };
    default:
      return { tone: 'error', icon: 'alert', title: 'Something went wrong', text: message || 'Try again. If it keeps failing, reload the page.', actions: [{ id: 'retry', label: 'Try again', primary: true }] };
  }
}

/** Banner for the current situation, or null. Priority: tab context → error → download progress → official track. */
export function pickBanner(status: DubStatus, context: TabContext, s: Settings, keys: KeyHints): BannerSpec | null {
  if (context === 'not-youtube') {
    return { tone: 'info', icon: 'video', title: 'Open a YouTube video to dub it', text: 'Your settings below apply to every video.' };
  }
  if (context === 'reload') {
    return { tone: 'warn', icon: 'refresh', title: 'Reload this page', text: 'AutoDub was installed or updated after this tab opened.', actions: [{ id: 'reload', label: 'Reload page', primary: true }] };
  }
  if (status.state === 'error') return errorBanner(status.error, s.targetLang, status.message);
  if (status.state === 'preparing' && status.message) {
    const m = /(\d{1,3})\s*%/.exec(status.message);
    const download = /download/i.test(status.message);
    return {
      tone: 'info', icon: download ? 'download' : 'info', title: status.message.replace(/\s*\d{1,3}\s*%\s*$/, ''),
      text: download ? 'One time only. Translation then runs on this device for free.' : undefined,
      progress: m ? Math.min(100, Number(m[1])) : 'indeterminate',
    };
  }
  if (status.usingOfficialAudio) {
    return { tone: 'info', icon: 'info', title: status.message ?? `Using YouTube's official ${LANG_INFO[s.targetLang].name} audio`, text: 'Real voice actors, no AI dub needed. Turn off "Use official audio" below to hear the AI dub.' };
  }
  if (status.officialTrackLang && status.officialTrackLang === s.targetLang) {
    return {
      tone: 'info', icon: 'info', title: `YouTube has an official ${LANG_INFO[s.targetLang].name} track`,
      text: 'For the original voice actors: player ⚙ Settings → Audio track. Or keep the AI dub.',
    };
  }
  if (isApiEngine(s.engine) && !keys[s.engine]) {
    return { tone: 'warn', icon: 'key', title: `Add your ${ENGINE_INFO[s.engine].name} key`, text: 'Until then AutoDub uses the free browser voice.', actions: [{ id: 'open-engine', label: 'Add key', primary: true }] };
  }
  return null;
}

/** Notice when only one gender is installed for a webspeech language. Returns the missing gender or null. */
export function missingGender(voices: VoiceInfo[]): 'male' | 'female' | null {
  if (!voices.length) return null;
  const { male: hasM, female: hasF } = gendersOf(voices);
  if (hasM && !hasF) return 'female';
  if (hasF && !hasM) return 'male';
  return null;
}

// ---------------------------------------------------------------- real backend

function realBackend(): PopupBackend {
  let tabId: number | null = null;
  let tabUrl: string | undefined;
  // Tab lookup runs once; voice/test calls wait for it so they reach the tab, not the popup fallback.
  let tabLookup: Promise<void> | null = null;
  const findTab = () => (tabLookup ??= (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id ?? null;
      tabUrl = tab?.url;
    } catch {
      tabId = null;
    }
  })());

  const backend: PopupBackend = {
    loadSettings,
    saveSettings,
    async keyHints() {
      const s = await getSecrets();
      const out: KeyHints = {};
      if (s.openaiKey) out.openai = s.openaiKey.slice(-4);
      if (s.elevenKey) out.elevenlabs = s.elevenKey.slice(-4);
      return out;
    },
    async saveKey(engine, key) {
      await saveSecrets(engine === 'openai' ? { openaiKey: key ?? '' } : { elevenKey: key ?? '' });
    },
    async connect() {
      await findTab();
      if (tabId == null) return { context: 'not-youtube', status: { state: 'idle' } };
      const res = await sendToTab(tabId, { type: 'GET_STATUS' }, 1500);
      if (res.ok) return { context: 'youtube', status: res.status };
      // No content script answered. If we can see it's YouTube (url visible via host access), ask for a reload.
      const onYouTube = !!tabUrl && /^https:\/\/www\.youtube\.com\//.test(tabUrl) && !/\/shorts\//.test(tabUrl);
      return { context: onYouTube ? 'reload' : 'not-youtube', status: { state: 'idle' } };
    },
    async toggle(on) {
      if (tabId == null) return { ok: false, error: 'NOT_WATCH_PAGE' };
      return sendToTab(tabId, { type: 'DUB_TOGGLE', on }, 5000);
    },
    async listVoices(lang, engine) {
      if (engine !== 'webspeech') return listVoicesB(lang, engine);
      await findTab();
      if (tabId != null) {
        const res = await sendToTab(tabId, { type: 'LIST_VOICES', lang }, 4000);
        if (res.ok && res.voices.length) return res.voices.filter((v) => v.engine === 'webspeech' || !v.engine);
        if (res.ok) return [];
      }
      return listVoicesB(lang, 'webspeech');
    },
    async testVoice(lang, engine, voice) {
      await findTab();
      if (tabId != null) {
        const res = await sendToTab(tabId, { type: 'TEST_VOICE', lang, engine, voice }, 20000);
        if (res.ok || res.error !== 'NETWORK') return res;
      }
      return localTest(lang, engine, voice);
    },
    requestHost(engine) {
      // Called first thing in a click handler: keeps the user gesture.
      return chrome.permissions.request({ origins: [HOSTS[engine]] }).catch(() => false);
    },
    async removeHost(engine) {
      try { await chrome.permissions.remove({ origins: [HOSTS[engine]] }); } catch { /* not granted */ }
    },
    onStatus(cb) {
      chrome.runtime.onMessage.addListener((msg: unknown, sender: chrome.runtime.MessageSender) => {
        const m = msg as { type?: string; status?: DubStatus };
        if (m?.type !== 'STATUS' || !m.status) return;
        if (sender.tab?.id != null && tabId != null && sender.tab.id !== tabId) return;
        cb(m.status);
      });
    },
    reloadTab() {
      if (tabId != null) void chrome.tabs.reload(tabId);
      window.close();
    },
    async neuralStatus(models, download) {
      const res = await sendToSW({ type: 'NEURAL_STATUS', models, download }, 15000);
      return res.ok ? res.models : models.map((model) => ({ model, ready: false, error: res.message ?? res.error }));
    },
  };
  return backend;
}

async function localTest(lang: Lang, engine: EngineId, voice: string): Promise<MsgResponse> {
  const text = TEST_LINES[lang];
  if (engine === 'webspeech') {
    if (typeof speechSynthesis === 'undefined') return { ok: false, error: 'NO_VOICE' };
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === voice);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANG_INFO[lang].bcp47;
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    return { ok: true };
  }
  const res = engine === 'neural'
    ? await sendToSW({ type: 'NEURAL_TTS', text, lang, voice }, 20000)
    : await sendToSW({ type: 'TTS', text, lang, engine, voice });
  if (!res.ok) return res;
  if (!res.audioB64) return { ok: false, error: 'NO_VOICE', message: 'Neural voice still downloading' };
  try {
    await new Audio(`data:${res.mime ?? 'audio/wav'};base64,${res.audioB64}`).play();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'ENGINE_ERROR', message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- mock backend (?mock=<state>)

export const MOCK_STATES = [
  'idle', 'preparing', 'dubbing', 'paused-ad', 'error', 'not-youtube', 'engine-open', 'dark',
  'loading', 'empty', 'official', 'reload', 'light',
] as const;
export type MockState = (typeof MOCK_STATES)[number];

const V = (id: string, name: string, lang: string, gender: Gender, quality: number): VoiceInfo =>
  ({ id, name, lang, engine: 'webspeech', gender, quality });

const MOCK_VOICES: Record<Lang, VoiceInfo[]> = {
  fr: [V('am', 'Amélie (Enhanced)', 'fr-CA', 'female', 3), V('th', 'Thomas (Enhanced)', 'fr-FR', 'male', 3), V('gfr', 'Google français', 'fr-FR', 'unknown', 2), V('au', 'Audrey', 'fr-FR', 'female', 1)],
  ar: [V('mj', 'Majed (Enhanced)', 'ar-001', 'male', 3), V('ll', 'Laila', 'ar-001', 'female', 2)],
  en: [V('sa', 'Samantha (Enhanced)', 'en-US', 'female', 3), V('da', 'Daniel', 'en-GB', 'male', 2)],
  es: [V('mo', 'Mónica (Enhanced)', 'es-ES', 'female', 3), V('jo', 'Jorge', 'es-ES', 'male', 2)],
  tr: [V('ye', 'Yelda (Enhanced)', 'tr-TR', 'female', 3)],
};

export function mockBackend(state: string): PopupBackend {
  const st = (MOCK_STATES as readonly string[]).includes(state) ? (state as MockState) : 'idle';
  const presets: Record<MockState, Partial<Settings>> = {
    idle: {}, light: {}, preparing: {}, official: {}, reload: {}, loading: {},
    dubbing: { targetLang: 'ar', showSubtitles: true, voiceByLang: { ar: 'mj' } },
    'paused-ad': { targetLang: 'tr', duckLevel: 0.2, voiceSpeed: 0.9 },
    error: { targetLang: 'tr' },
    'not-youtube': { targetLang: 'es' },
    'engine-open': { engine: 'openai', voiceByLang: { fr: 'nova' } },
    dark: { targetLang: 'fr', voiceByLang: { fr: 'th' } },
    empty: { targetLang: 'ar' },
  };
  const base = presets[st];
  let settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...base });
  const status: DubStatus = {
    idle: { state: 'idle' as const }, light: { state: 'idle' as const }, loading: { state: 'idle' as const },
    preparing: { state: 'preparing' as const, message: 'Downloading French translator… 42%' },
    dubbing: { state: 'dubbing' as const, videoId: 'mock', firstLineMs: 2100 },
    'paused-ad': { state: 'paused-ad' as const },
    error: { state: 'error' as const, error: 'NO_TRANSLATION' as const },
    'not-youtube': { state: 'idle' as const },
    'engine-open': { state: 'dubbing' as const },
    dark: { state: 'dubbing' as const },
    empty: { state: 'idle' as const },
    official: { state: 'idle' as const, officialTrackLang: 'fr' as const },
    reload: { state: 'idle' as const },
  }[st];
  const context: TabContext = st === 'not-youtube' ? 'not-youtube' : st === 'reload' ? 'reload' : 'youtube';
  const keys: KeyHints = st === 'engine-open' ? { openai: '3fQa' } : {};
  const never = new Promise<never>(() => {});
  let cb: ((s: DubStatus) => void) | null = null;
  return {
    theme: st === 'dark' ? 'dark' : st === 'light' ? 'light' : undefined,
    engineOpen: st === 'engine-open',
    async loadSettings() { return settings; },
    async saveSettings(p) { settings = normalizeSettings({ ...settings, ...p, voiceByLang: { ...settings.voiceByLang, ...(p.voiceByLang ?? {}) } }); return settings; },
    async keyHints() { return { ...keys }; },
    async saveKey(engine, key) { if (key) keys[engine] = key.slice(-4); else delete keys[engine]; },
    connect() { return st === 'loading' ? never : Promise.resolve({ context, status }); },
    async toggle(on) { const s: DubStatus = { state: on ? 'preparing' : 'idle' }; setTimeout(() => cb?.({ state: on ? 'dubbing' : 'idle' }), 800); return { ok: true, status: s }; },
    listVoices(lang, engine) {
      if (st === 'loading') return never;
      if (engine !== 'webspeech') return listVoicesB(lang, engine);
      return Promise.resolve(st === 'empty' ? [] : MOCK_VOICES[lang]);
    },
    async testVoice() { return { ok: true }; },
    async requestHost() { return true; },
    async removeHost() {},
    onStatus(f) { cb = f; },
    reloadTab() {},
    async neuralStatus(models) {
      // engine-open mock: one voice downloading, one ready; others: nothing downloaded (keeps their engine as is).
      return models.map((model, i) => (st === 'engine-open' ? { model, ready: i > 0, progress: i > 0 ? undefined : 0.42 } : { model, ready: false }));
    },
  };
}

// ---------------------------------------------------------------- view

interface ViewState {
  settings: Settings;
  status: DubStatus;
  context: TabContext;
  voices: VoiceInfo[] | null; // null = loading
  keys: KeyHints;
  busy: boolean;
  engineMsg: { text: string; tone: string } | null;
  testMsg: { text: string; tone: string } | null;
  testing: boolean;
  /** v1.1 neural model states for the target language (null = not loaded). */
  neural: NeuralModelState[] | null;
}

const SHELL = `
<header class="hdr">
  <div class="logo">${icon('logo')}</div>
  <div class="brand">
    <h1>AutoDub</h1>
    <p class="status" data-el="status"><span class="dot"></span><span class="status-text" data-el="status-text"></span></p>
  </div>
  <label class="switch big" data-el="power-wrap" title="Dub this video (Alt+D)">
    <input type="checkbox" role="switch" data-el="power" aria-label="Dub this video" />
    <span class="track"><span class="thumb"></span></span>
  </label>
</header>
<div class="banner-slot" data-el="banner" role="status"></div>
<section class="sec" aria-labelledby="h-lang">
  <h2 class="sec-title" id="h-lang">Dub into</h2>
  <div class="langs" role="radiogroup" aria-labelledby="h-lang" data-el="langs"></div>
</section>
<section class="sec" aria-labelledby="h-voice">
  <h2 class="sec-title" id="h-voice">Voice</h2>
  <div data-el="voice"></div>
  <div class="voice-extra" data-el="voice-extra">
    <div class="row">
      <span class="row-label"><span>Match speaker’s voice</span><span class="row-sub">Male speaker → male voice, female → female</span></span>
      <label class="switch"><input type="checkbox" role="switch" data-el="gender" aria-label="Match speaker's voice (male/female)" /><span class="track"><span class="thumb"></span></span></label>
    </div>
    <div data-el="gender-note"></div>
  </div>
</section>
<section class="sec" aria-label="Audio">
  <div class="slider">
    <div class="slider-head"><label for="s-duck">Original audio</label><span class="slider-val" data-el="duck-val"></span></div>
    <input id="s-duck" type="range" min="0" max="100" step="5" data-el="duck" />
  </div>
  <div class="slider">
    <div class="slider-head"><label for="s-vol">Dub volume</label><span class="slider-val" data-el="vol-val"></span></div>
    <input id="s-vol" type="range" min="0" max="100" step="5" data-el="vol" />
  </div>
  <div class="slider">
    <div class="slider-head"><label for="s-speed">Voice speed</label><span class="slider-val" data-el="speed-val"></span></div>
    <input id="s-speed" type="range" min="${VOICE_SPEED_MIN}" max="${VOICE_SPEED_MAX}" step="0.05" data-el="speed" />
  </div>
</section>
<section class="sec">
  <div class="row">
    <span class="row-label"><span>Show translated subtitles</span><span class="row-sub">On the video, under the dub</span></span>
    <label class="switch"><input type="checkbox" role="switch" data-el="subs" aria-label="Show translated subtitles" /><span class="track"><span class="thumb"></span></span></label>
  </div>
  <div class="row">
    <span class="row-label"><span>Use official audio when available</span><span class="row-sub">Real voice actors (e.g. MrBeast in French) instead of the AI dub</span></span>
    <label class="switch"><input type="checkbox" role="switch" data-el="official" aria-label="Use official audio when available" /><span class="track"><span class="thumb"></span></span></label>
  </div>
  <div class="row">
    <span class="row-label"><span>Smart French (on-device AI)</span><span class="row-sub">Shortens long lines so the voice keeps pace. Free, Chrome's built-in AI</span></span>
    <label class="switch"><input type="checkbox" role="switch" data-el="smart" aria-label="Smart French" /><span class="track"><span class="thumb"></span></span></label>
  </div>
</section>
<details class="engine" data-el="engine">
  <summary>${icon('sliders')}<span>Engine</span><span class="summary-val" data-el="engine-val"></span>${icon('chevron', 'icon chev')}</summary>
  <div class="engine-body">
    <div class="engines" role="radiogroup" aria-label="Voice engine" data-el="engines"></div>
    <div data-el="neural"></div>
    <div data-el="key"></div>
  </div>
</details>
<footer class="footer">${icon('shield')}<span>Voice is AI-generated · No account · No server · Keys stay on this device.</span></footer>
`;

/** Render the popup into `root` and wire settings, status, voices, test voice and keys. */
export async function initPopup(root: HTMLElement, opts: InitOptions = {}): Promise<void> {
  const mock = opts.mock !== undefined ? opts.mock : mockParam();
  const be = opts.backend ?? (mock ? mockBackend(mock) : realBackend());
  if (be.theme) document.documentElement.dataset.theme = be.theme;

  root.innerHTML = SHELL;
  const $ = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-el="${name}"]`)!;

  const vs: ViewState = {
    settings: normalizeSettings(DEFAULT_SETTINGS),
    status: { state: 'idle' },
    context: 'loading',
    voices: null,
    keys: {},
    busy: false,
    engineMsg: null,
    testMsg: null,
    testing: false,
    neural: null,
  };
  root.dataset.context = 'loading';

  // ------------ header + banner
  const renderHeader = () => {
    const { text, tone } = statusLine(vs.status, vs.context, vs.settings.targetLang);
    const st = $('status');
    st.dataset.tone = tone;
    $('status-text').textContent = text;
    const power = $<HTMLInputElement>('power');
    const on = vs.status.state === 'preparing' || vs.status.state === 'dubbing' || vs.status.state === 'paused-ad';
    power.checked = on;
    power.disabled = vs.context !== 'youtube' || vs.status.error === 'NOT_WATCH_PAGE' || vs.busy;
    $('power-wrap').dataset.busy = String(vs.status.state === 'preparing' || vs.busy);
    root.dataset.state = vs.context === 'youtube' ? vs.status.state : vs.context;
  };

  const renderBanner = () => {
    const slot = $('banner');
    const b = vs.context === 'loading' ? null : pickBanner(vs.status, vs.context, vs.settings, vs.keys);
    if (!b) { slot.innerHTML = ''; return; }
    const progress = b.progress === undefined ? ''
      : b.progress === 'indeterminate' ? '<div class="progress" data-indeterminate="true"><span></span></div>'
      : `<div class="progress" role="progressbar" aria-valuenow="${b.progress}" aria-valuemin="0" aria-valuemax="100"><span style="width:${b.progress}%"></span></div>`;
    const actions = b.actions?.length
      ? `<div class="banner-actions">${b.actions.map((a) => `<button type="button" class="btn btn-sm ${a.primary ? 'btn-primary' : ''}" data-action="${a.id}">${esc(a.label)}</button>`).join('')}</div>`
      : '';
    slot.innerHTML = `<div class="banner" data-tone="${b.tone}" data-banner>${icon(b.icon)}<div class="banner-body">
      <p class="banner-title">${esc(b.title)}</p>${b.text ? `<p class="banner-text">${esc(b.text)}</p>` : ''}${progress}${actions}</div></div>`;
  };

  // ------------ language
  const renderLangs = () => {
    $('langs').innerHTML = LANGS.map((l) => {
      const info = LANG_INFO[l];
      const sel = l === vs.settings.targetLang;
      return `<button type="button" class="lang" role="radio" aria-checked="${sel}" data-lang="${l}" title="${info.name}" lang="${info.bcp47}">
        <span class="lang-code">${l.toUpperCase()}</span><span class="lang-name" ${info.rtl ? 'dir="rtl"' : ''}>${esc(info.native)}</span></button>`;
    }).join('');
  };

  // ------------ voice
  const selectedVoiceId = (): string | undefined => {
    const list = vs.voices ?? [];
    const saved = vs.settings.voiceByLang[vs.settings.targetLang];
    return list.find((v) => v.id === saved)?.id ?? list[0]?.id;
  };

  const renderVoice = () => {
    const box = $('voice');
    $('voice-extra').hidden = vs.voices !== null && vs.voices.length === 0;
    const lang = vs.settings.targetLang;
    const L = LANG_INFO[lang].name;
    if (vs.voices === null) {
      box.innerHTML = `<div class="voice-row" aria-busy="true" aria-label="Loading voices" data-skeleton><div class="skeleton sk-select"></div><div class="skeleton sk-btn"></div></div>`;
      $('gender-note').innerHTML = '';
      return;
    }
    if (!vs.voices.length) {
      box.innerHTML = `<div class="help" data-empty><p><strong>No ${esc(L)} voice is installed on this Mac.</strong></p>
        <p>Add one (free), then reopen this popup:</p>${pathHtml()}</div>`;
      $('gender-note').innerHTML = '';
      return;
    }
    const sel = selectedVoiceId();
    const opts = vs.voices.map((v, i) => `<option value="${esc(v.id)}" ${v.id === sel ? 'selected' : ''}>${esc(voiceLabel(v, i === 0 && vs.voices!.length > 1))}</option>`).join('');
    box.innerHTML = `<div class="voice-row">
      <div class="select-wrap"><select data-el="voice-select" title="${esc(vs.voices.find((v) => v.id === sel)?.name ?? '')}" aria-label="${esc(L)} voice">${opts}</select>${icon('chevron')}</div>
      <button type="button" class="btn btn-test" data-el="test" ${vs.testing ? 'disabled' : ''}>${icon(vs.testing ? 'stop' : 'play')}<span>${vs.testing ? 'Playing' : 'Test'}</span></button>
    </div>
    <p class="inline-msg" data-el="test-msg" ${vs.testMsg ? `data-tone="${vs.testMsg.tone}"` : ''}>${vs.testMsg ? esc(vs.testMsg.text) : ''}</p>`;
    renderGenderNote();
  };

  const pathHtml = (lang?: string) =>
    `<div class="path">${[...MAC_PATH, ...(lang ? [lang] : [])].map((p, i) => `${i ? icon('right') : ''}<span>${esc(p)}</span>`).join('')}</div>`;

  const renderGenderNote = () => {
    const note = $('gender-note');
    const voices = vs.voices ?? [];
    if (!voices.length) { note.innerHTML = ''; return; }
    const males = voices.filter((v) => v.gender === 'male').length;
    const females = voices.filter((v) => v.gender !== 'male').length;
    const missing = vs.settings.engine === 'webspeech' ? missingGender(voices) : null;
    const hq = vs.settings.engine === 'webspeech' && !hasHighQualityVoice(voices) ? qualityHint() : '';
    const tags = `<div class="gender-tags">
      <span class="tag" ${!females ? 'data-missing="true"' : ''}><b>${females}</b>female</span>
      <span class="tag" ${!males ? 'data-missing="true"' : ''}><b>${males}</b>male</span></div>`;
    if (!missing) { note.innerHTML = (vs.settings.matchSpeakerGender ? tags : '') + hq; return; }
    const lang = vs.settings.targetLang;
    note.innerHTML = `${tags}<div class="help" data-gender-notice><p><strong>Only ${missing === 'male' ? 'female' : 'male'} ${esc(LANG_INFO[lang].name)} voices are installed.</strong>
      To add a ${missing} voice such as ${esc(SUGGEST[lang][missing])}:</p>${pathHtml()}</div>${hq}`;
  };

  /** Only compact (robotic) browser voices: point to the free neural voices and to the Mac's Premium/Enhanced voices. */
  const qualityHint = () => {
    const lang = vs.settings.targetLang;
    const L = LANG_INFO[lang].name;
    const hq = MAC_HQ_VOICES[lang];
    return `<div class="help" data-quality-hint><p><strong>These ${esc(L)} voices sound robotic.</strong>
      Best free option: <button type="button" class="link" data-action="use-neural">Neural voices</button> (on this computer).
      Or download a natural Mac voice such as <b>${esc(hq.female)}</b> or <b>${esc(hq.male)}</b>:</p>
      ${pathHtml(LANG_INFO[lang].native)}<p class="row-sub">Then quit and reopen Chrome.</p></div>`;
  };

  // ------------ sliders + toggles
  const setPct = (input: HTMLInputElement) => {
    const min = Number(input.min), max = Number(input.max);
    input.style.setProperty('--pct', `${((Number(input.value) - min) / (max - min)) * 100}%`);
  };
  const renderControls = () => {
    const s = vs.settings;
    const duck = $<HTMLInputElement>('duck'), vol = $<HTMLInputElement>('vol'), speed = $<HTMLInputElement>('speed');
    duck.value = String(Math.round(s.duckLevel * 100));
    vol.value = String(Math.round(s.dubVolume * 100));
    speed.value = String(s.voiceSpeed);
    [duck, vol, speed].forEach(setPct);
    $('duck-val').textContent = `${duck.value}%`;
    $('vol-val').textContent = `${vol.value}%`;
    $('speed-val').textContent = `${Number(speed.value).toFixed(2)}×`;
    $<HTMLInputElement>('subs').checked = s.showSubtitles;
    $<HTMLInputElement>('gender').checked = s.matchSpeakerGender;
    $<HTMLInputElement>('official').checked = s.preferOfficialAudio;
    $<HTMLInputElement>('smart').checked = s.smartFrench;
  };

  // ------------ engine
  const renderEngine = () => {
    const s = vs.settings;
    $('engine-val').textContent = ENGINE_INFO[s.engine].short;
    const hasNeural = neuralVoicesFor(s.targetLang).length > 0;
    $('engines').innerHTML = ((hasNeural ? ['neural'] : []).concat(['webspeech', 'openai', 'elevenlabs']) as EngineId[]).map((e) => {
      const info = ENGINE_INFO[e];
      const tag = e === 'neural' && s.targetLang === 'fr' ? 'Best free' : info.tag;
      const rec = e === 'neural' ? ' data-recommended="true"' : '';
      return `<label class="eng"${rec}><input type="radio" name="engine" value="${e}" ${e === s.engine ? 'checked' : ''} />
        <span><span class="eng-name">${info.name}${e === 'neural' && s.targetLang === 'fr' ? ' <span class="eng-rec">Recommended for French</span>' : ''}</span><span class="eng-sub">${info.sub}</span></span><span class="eng-tag">${tag}</span></label>`;
    }).join('');
    renderNeural();
    const keyBox = $('key');
    if (!isApiEngine(s.engine)) {
      keyBox.innerHTML = vs.engineMsg ? `<p class="inline-msg" data-tone="${vs.engineMsg.tone}">${esc(vs.engineMsg.text)}</p>` : '';
      return;
    }
    const e = s.engine;
    const hint = vs.keys[e];
    const field = hint
      ? `<div class="key-saved" data-key-saved>${icon('check')}<span>Key saved</span><code>••••${esc(hint)}</code></div>
         <button type="button" class="btn btn-ghost" data-el="key-remove">Remove</button>`
      : `<input type="password" autocomplete="off" spellcheck="false" data-el="key-input" placeholder="${KEY_PLACEHOLDER[e]}" aria-label="${ENGINE_INFO[e].name} API key" />
         <button type="button" class="btn btn-primary" data-el="key-save">Save</button>`;
    keyBox.innerHTML = `<div class="key">
      <label class="key-label">${ENGINE_INFO[e].name} API key</label>
      <div class="key-row">${field}</div>
      ${vs.engineMsg ? `<p class="inline-msg" data-tone="${vs.engineMsg.tone}">${esc(vs.engineMsg.text)}</p>` : ''}
      <ul class="key-notes">
        <li>${icon('key')}<span>Use a dedicated key you can revoke. It is stored only on this device and sent only to ${e === 'openai' ? 'api.openai.com' : 'api.elevenlabs.io'}.</span></li>
        <li>${icon('info')}<span>${COST_HINT[e]}</span></li>
      </ul></div>`;
  };

  // ------------ neural voices (v1.1)
  const neuralModels = () => recommendedModels(vs.settings.targetLang);
  const renderNeural = () => {
    const box = $('neural');
    const lang = vs.settings.targetLang;
    const voices = neuralVoicesFor(lang).filter((v) => v.recommended);
    if (vs.settings.engine !== 'neural' || !voices.length) { box.innerHTML = ''; return; }
    const states = vs.neural ?? [];
    const st = (m: string) => states.find((x) => x.model === m);
    const allReady = voices.every((v) => st(v.model)?.ready);
    const downloading = states.filter((x) => !x.ready && x.progress !== undefined);
    const err = states.find((x) => x.error)?.error;
    const mb = [...new Map(voices.map((v) => [v.model, v.sizeMB])).values()].reduce((a, b) => a + b, 0);
    const list = voices.map((v) => {
      const s = st(v.model);
      const state = s?.ready ? `${icon('check')}<span>Ready</span>` : s?.progress !== undefined ? `<span>${Math.round(s.progress * 100)}%</span>` : '<span>Not downloaded</span>';
      return `<li data-neural-voice="${esc(v.id)}" data-ready="${!!s?.ready}"><span class="nv-name">${esc(v.name)}</span><span class="nv-g">${v.gender === 'male' ? 'Male' : 'Female'}</span><span class="nv-state">${state}</span></li>`;
    }).join('');
    const pct = downloading.length ? Math.round((downloading.reduce((a, x) => a + (x.progress ?? 0), 0) / voices.length) * 100) : 0;
    const progress = downloading.length
      ? `<div class="progress" role="progressbar" aria-label="Downloading neural voices" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`
      : '';
    const action = allReady || downloading.length || vs.neural === null ? ''
      : `<button type="button" class="btn btn-primary" data-action="neural-download">${icon('download')}<span>Download ${esc(LANG_INFO[lang].name)} voices (${mb} MB)</span></button>`;
    box.innerHTML = `<div class="neural" data-neural>
      <p class="row-sub">${allReady ? 'Downloaded. Runs on this computer: free, private, no key.' : `One-time download from Hugging Face (${mb} MB). Until it finishes, the browser voice speaks.`}</p>
      <ul class="nv-list">${list}</ul>${progress}${action}
      ${err ? `<p class="inline-msg" data-tone="error">Download failed: ${esc(err)}</p>` : ''}</div>`;
  };

  let neuralTimer: ReturnType<typeof setTimeout> | undefined;
  /** Refresh model states; polls while downloading; switches to 'neural' when ready if preferNeural (v1.1). */
  const refreshNeural = async (download?: string[]) => {
    clearTimeout(neuralTimer);
    const models = neuralModels();
    if (!models.length) { vs.neural = []; renderNeural(); return; }
    try { vs.neural = await be.neuralStatus(models, download); } catch { vs.neural = []; }
    const ready = vs.neural.length > 0 && vs.neural.every((m) => m.ready);
    if (ready && vs.settings.preferNeural && vs.settings.engine === 'webspeech' && vs.settings.targetLang === 'fr') {
      await save({ engine: 'neural' });
      renderEngine(); void loadVoices();
    }
    renderNeural();
    if (vs.neural.some((m) => !m.ready && m.progress !== undefined && !m.error)) neuralTimer = setTimeout(() => void refreshNeural(), 700);
  };

  const renderAll = () => {
    renderHeader(); renderBanner(); renderLangs(); renderVoice(); renderControls(); renderEngine();
  };

  // ------------ data loading
  let voiceReq = 0;
  const loadVoices = async () => {
    const id = ++voiceReq;
    vs.voices = null;
    vs.testMsg = null;
    renderVoice();
    let list: VoiceInfo[] = [];
    try { list = await be.listVoices(vs.settings.targetLang, vs.settings.engine); } catch { list = []; }
    if (id !== voiceReq) return;
    vs.voices = [...list].sort((a, b) => b.quality - a.quality);
    renderVoice();
  };

  // saveSettings is read-modify-write: serialise so quick successive changes don't overwrite each other.
  let saveQueue: Promise<unknown> = Promise.resolve();
  const save = (patch: Partial<Settings>): Promise<void> => {
    const run = saveQueue.then(async () => { vs.settings = await be.saveSettings(patch); });
    saveQueue = run.catch(() => {});
    return run;
  };
  const saveSoon = debounce((patch: Partial<Settings>) => void save(patch), 150);

  // ------------ events
  root.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const langBtn = t.closest<HTMLElement>('[data-lang]');
    if (langBtn) {
      const lang = langBtn.dataset.lang as Lang;
      if (lang === vs.settings.targetLang) return;
      vs.settings = { ...vs.settings, targetLang: lang };
      renderLangs(); renderHeader(); renderBanner();
      void save({ targetLang: lang });
      void loadVoices();
      renderEngine();
      void refreshNeural();
      return;
    }
    const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'open-engine') { ($('engine') as HTMLDetailsElement).open = true; $('engine').scrollIntoView({ block: 'nearest' }); return; }
    if (action === 'retry') { void doToggle(true); return; }
    if (action === 'neural-download') { void refreshNeural(neuralModels()); return; }
    if (action === 'use-neural') { onEngineChange('neural'); ($('engine') as HTMLDetailsElement).open = true; return; }
    if (action === 'reload') { be.reloadTab(); return; }
    if (t.closest('[data-el="test"]')) { void doTest(); return; }
    if (t.closest('[data-el="key-save"]')) { doSaveKey(); return; }
    if (t.closest('[data-el="key-remove"]')) { void doRemoveKey(); return; }
  });

  root.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.matches('[data-el="key-input"]') && ev.key === 'Enter') { ev.preventDefault(); doSaveKey(); }
    if (t.matches('[data-lang]') && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
      const i = LANGS.indexOf(vs.settings.targetLang) + (ev.key === 'ArrowRight' ? 1 : -1);
      const next = root.querySelector<HTMLElement>(`[data-lang="${LANGS[(i + LANGS.length) % LANGS.length]}"]`);
      next?.click(); root.querySelector<HTMLElement>(`[data-lang="${vs.settings.targetLang}"]`)?.focus();
    }
  });

  root.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    const el = t.dataset.el;
    if (el === 'duck') { setPct(t); $('duck-val').textContent = `${t.value}%`; saveSoon({ duckLevel: Number(t.value) / 100 }); }
    else if (el === 'vol') { setPct(t); $('vol-val').textContent = `${t.value}%`; saveSoon({ dubVolume: Number(t.value) / 100 }); }
    else if (el === 'speed') { setPct(t); $('speed-val').textContent = `${Number(t.value).toFixed(2)}×`; saveSoon({ voiceSpeed: Number(t.value) }); }
  });

  root.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const el = t.dataset.el;
    if (el === 'power') { void doToggle(t.checked); return; }
    if (el === 'subs') { void save({ showSubtitles: t.checked }); return; }
    if (el === 'official') { void save({ preferOfficialAudio: t.checked }); return; }
    if (el === 'smart') { void save({ smartFrench: t.checked }); return; }
    if (el === 'gender') { void save({ matchSpeakerGender: t.checked }).then(renderGenderNote); return; }
    if (el === 'voice-select') {
      vs.testMsg = null;
      void save({ voiceByLang: { [vs.settings.targetLang]: t.value } });
      return;
    }
    if (t.name === 'engine') { onEngineChange(t.value as EngineId); return; }
  });

  const doToggle = async (on: boolean) => {
    if (vs.context !== 'youtube') return;
    vs.busy = true;
    if (on) vs.status = { ...vs.status, state: 'preparing', error: undefined, message: undefined };
    renderHeader(); renderBanner();
    const res = await be.toggle(on);
    vs.busy = false;
    // Transport errors (NETWORK/TIMEOUT/NO_KEY) are not DubErrorCodes but errorBanner() knows them.
    vs.status = res.ok ? res.status : { state: 'error', error: res.error as DubErrorCode, message: res.message };
    renderHeader(); renderBanner();
  };

  const doTest = async () => {
    const voice = selectedVoiceId();
    if (!voice || vs.testing) return;
    vs.testing = true; vs.testMsg = null; renderVoice();
    const res = await be.testVoice(vs.settings.targetLang, vs.settings.engine, voice);
    vs.testMsg = res.ok ? null : { tone: 'error', text: testError(res.error, res.message) };
    setTimeout(() => { vs.testing = false; renderVoice(); }, res.ok ? 1800 : 0);
    if (!res.ok) { vs.testing = false; renderVoice(); }
  };

  const onEngineChange = (engine: EngineId) => {
    const prev = vs.settings.engine;
    vs.engineMsg = null;
    // Permission request must start synchronously inside the user gesture.
    const granted = isApiEngine(engine) ? be.requestHost(engine) : Promise.resolve(true);
    void granted.then(async (ok) => {
      if (!ok) {
        vs.engineMsg = { tone: 'error', text: `Permission to reach ${engine === 'openai' ? 'api.openai.com' : 'api.elevenlabs.io'} was not given. Still using ${ENGINE_INFO[prev].short}.` };
        renderEngine();
        return;
      }
      // Drop hosts we no longer need. Keep OpenAI while its key is saved: it also translates (§1 C5).
      for (const e of ['openai', 'elevenlabs'] as ApiEngine[]) {
        if (e !== engine && e === prev && !(e === 'openai' && vs.keys.openai)) await be.removeHost(e);
      }
      // v1.1: an explicit choice of Web Speech stops the automatic switch to neural voices.
      await save(engine === 'webspeech' ? { engine, preferNeural: false } : engine === 'neural' ? { engine, preferNeural: true } : { engine });
      renderEngine(); renderBanner();
      void loadVoices();
      if (engine === 'neural') void refreshNeural(neuralModels());
    });
  };

  const doSaveKey = () => {
    const e = vs.settings.engine;
    if (!isApiEngine(e)) return;
    const input = root.querySelector<HTMLInputElement>('[data-el="key-input"]');
    const key = input?.value.trim() ?? '';
    if (!key) { vs.engineMsg = { tone: 'error', text: 'Paste your key first.' }; renderEngine(); return; }
    if (key.length < 20 || /\s/.test(key)) { vs.engineMsg = { tone: 'error', text: 'That doesn’t look like an API key.' }; renderEngine(); return; }
    const granted = be.requestHost(e); // user gesture
    void granted.then(async (ok) => {
      if (!ok) { vs.engineMsg = { tone: 'error', text: 'Permission was not given, so the key can’t be used.' }; renderEngine(); return; }
      await be.saveKey(e, key);
      if (input) input.value = '';
      vs.keys = await be.keyHints();
      vs.engineMsg = { tone: 'ok', text: 'Saved. Press Test to hear a voice (one short line).' };
      renderEngine(); renderBanner();
    });
  };

  const doRemoveKey = async () => {
    const e = vs.settings.engine;
    if (!isApiEngine(e)) return;
    await be.saveKey(e, null);
    vs.keys = await be.keyHints();
    vs.engineMsg = { tone: 'ok', text: 'Key removed from this device.' };
    renderEngine(); renderBanner();
  };

  be.onStatus((s) => { vs.status = s; renderHeader(); renderBanner(); });

  // ------------ boot
  renderAll();
  const [settings, keys] = await Promise.all([be.loadSettings(), be.keyHints().catch(() => ({}))]);
  vs.settings = settings;
  vs.keys = keys;
  if (be.engineOpen) ($('engine') as HTMLDetailsElement).open = true;
  renderAll();
  void loadVoices();
  void refreshNeural();
  void be.connect().then(({ context, status }) => {
    vs.context = context;
    vs.status = status;
    root.dataset.context = context;
    renderHeader(); renderBanner();
  });
  root.dataset.ready = 'true';
}

function testError(code: ErrorCode, message?: string): string {
  switch (code) {
    case 'NO_KEY': return 'Add your API key first.';
    case 'NO_VOICE': return 'This voice isn’t available. Pick another.';
    case 'TIMEOUT': return 'The voice service took too long. Try again.';
    case 'ENGINE_ERROR': return message ? `Voice service error: ${message}` : 'Voice service error. Check your key.';
    default: return message || 'Couldn’t play the test line.';
  }
}

function mockParam(): string | null {
  if (typeof location === 'undefined') return null;
  const p = new URLSearchParams(location.search);
  return p.get('mock') ?? p.get('state');
}

const appRoot = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (appRoot) void initPopup(appRoot);
