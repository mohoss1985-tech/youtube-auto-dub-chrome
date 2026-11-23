// AutoDub shared types (DESIGN_SPEC §8). Owner: A. Others import, never edit.

export type Lang = 'fr' | 'ar' | 'en' | 'es' | 'tr';
export type EngineId = 'webspeech' | 'openai' | 'elevenlabs';
export type Gender = 'male' | 'female' | 'unknown';

export interface CaptionTrack { baseUrl: string; languageCode: string; kind?: string; vssId: string; name?: string }
/** Times in seconds. */
export interface Cue { start: number; end: number; text: string }
/** One merged sentence. Times in seconds. `source` = original-language text when `text` is translated. */
export interface Line { id: string; start: number; end: number; text: string; source?: string; gender?: Gender }
/** Output of sync/fit: how to speak one line. `startAt` in seconds (media time), `maxMs` hard cut. */
export interface Plan { line: Line; rate: number; startAt: number; maxMs: number; trimmed: boolean }

export interface Settings {
  enabled: boolean;
  targetLang: Lang;
  engine: EngineId;
  /** voiceURI (webspeech) or voice id (API), per language. */
  voiceByLang: Partial<Record<Lang, string>>;
  /** Original-audio level while the dub speaks, 0..1 (default 0.15). */
  duckLevel: number;
  /** Dub volume 0..1. */
  dubVolume: number;
  /** User voice speed multiplier 0.75..1.3. */
  voiceSpeed: number;
  showBadge: boolean;
  showSubtitles: boolean;
  translateModel: string;
  matchSpeakerGender: boolean;
}

export interface Secrets { openaiKey?: string; elevenKey?: string }

export type DubState = 'idle' | 'preparing' | 'dubbing' | 'paused-ad' | 'error';
export type DubErrorCode = 'NO_CAPTIONS' | 'NO_TRANSLATION' | 'RATE_LIMITED' | 'ENGINE_ERROR' | 'NO_VOICE' | 'NOT_WATCH_PAGE';
/** Every error code that can cross runtime messaging. */
export type ErrorCode = DubErrorCode | 'NETWORK' | 'NO_KEY' | 'TIMEOUT';

export interface DubStatus {
  state: DubState;
  videoId?: string;
  error?: DubErrorCode;
  message?: string;
  officialTrackLang?: Lang;
  firstLineMs?: number;
  currentLineId?: string;
}

export interface Feedback { videoId: string; lineId: string; lang: Lang; up: boolean; rate: number; overflowMs: number; at: number }

export interface TtsRequest { text: string; lang: Lang; engine: 'openai' | 'elevenlabs'; voice: string; speed?: number }
export interface TtsResult { audioB64: string; mime: string }

/** Voice descriptor (re-exported by src/content/voice/voices.ts). `lang` is the voice's BCP-47 tag; `quality` higher = better. */
export interface VoiceInfo { id: string; name: string; lang: string; engine: EngineId; gender: Gender; quality: number }

/** SW IndexedDB object stores (§7). Only 'lines' crosses messaging. */
export type CacheStore = 'lines' | 'audio';

// ---- YouTube data shapes (community-known, see research/01) ----

export interface Json3Seg { utf8: string; tOffsetMs?: number; acAsrConf?: number }
export interface Json3Event { tStartMs: number; dDurationMs?: number; segs?: Json3Seg[]; aAppend?: number; wWinId?: number; id?: number }
export interface Json3 { events: Json3Event[] }

/** YouTube's alternative audio tracks (official / auto-dubbed). */
export interface AudioTrackInfo { languageCode: string; displayName?: string; isDefault?: boolean; isAutoDubbed?: boolean }

/** Subset of movie_player.getPlayerResponse() that AutoDub reads. */
export interface PlayerResponse {
  videoDetails?: { videoId: string; title?: string; lengthSeconds?: string; author?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: (CaptionTrack & { isTranslatable?: boolean })[];
      translationLanguages?: { languageCode: string; languageName?: unknown }[];
      audioTracks?: unknown[];
    };
  };
  streamingData?: { adaptiveFormats?: unknown[] };
  [k: string]: unknown;
}

/** Error carrying a machine code; thrown across modules and mapped to `{ok:false, error}` by routers. */
export class DubError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'DubError';
    this.code = code;
  }
}
