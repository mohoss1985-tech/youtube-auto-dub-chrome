// AutoDub shared types (DESIGN_SPEC §8). Owner: A. Others import, never edit.

export type Lang = 'fr' | 'ar' | 'en' | 'es' | 'tr';
export type EngineId = 'webspeech' | 'openai' | 'elevenlabs' | 'neural';
export type Gender = 'male' | 'female' | 'unknown';

export interface CaptionTrack { baseUrl: string; languageCode: string; kind?: string; vssId: string; name?: string }
/** Times in seconds. `gender` = caption speaker-label hint ([Man], (femme)…); `newSpeaker` = a `>>` / label speaker change starts here. */
export interface Cue { start: number; end: number; text: string; gender?: Gender; newSpeaker?: boolean; emph?: string[]; shout?: boolean }
/** One merged sentence. Times in seconds. `source` = original-language text when `text` is translated. `newSpeaker` (v1.1, optional) = a caption speaker change starts at this line. */
export interface Line {
  id: string; start: number; end: number; text: string; source?: string; gender?: Gender; newSpeaker?: boolean;
  /** v1.2 (E): words written in ALL CAPS in the ORIGINAL captions (lower-cased, before de-shouting). */
  emph?: string[];
  /** v1.2 (E): the original caption line was shouted (mostly capitals). */
  shout?: boolean;
  /** v1.2 (E): emotion known ahead of playback (text cues, optional Gemini Nano tag). */
  emotion?: LineEmotion;
}

/** v1.2 (E): delivery style of a dubbed line. */
export type EmotionStyle = 'neutral' | 'excited' | 'happy' | 'question' | 'surprised' | 'sad' | 'calm' | 'shout';
/** v1.2 (E): per-line emotion. `emphasisWords` are words of the TARGET text (`Line.text`) to stress. */
export interface LineEmotion { style: EmotionStyle; intensity: number; emphasisWords: string[]; by?: 'rules' | 'nano' }

/**
 * v1.2 (E): expressive rendering of one neural line (Piper inference noise + WAV post-processing).
 * Absent = the v1.1 sound, byte for byte.
 */
export interface ProsodyParams {
  /** Piper noise_scale (0.55–0.9) and noise_w (0.6–1.1). */
  noiseScale: number;
  noiseW: number;
  /** F0 contour expansion around the line mean (1 = unchanged, 1.2–1.8 expressive). */
  pitchK: number;
  /** Mean F0 shift (semitones). */
  meanShiftSt: number;
  /** F0 change reached at the end of the line (semitones; + = question rise, − = statement fall). */
  endShiftSt: number;
  /** Duration of that final glide (ms). */
  endMs: number;
  /** Overall gain (dB) before the soft limiter. */
  gainDb: number;
  /** Stressed spans as character fractions [from, to) of the text, with a level bump (dB) and pitch accent (st). */
  emphasis: { from: number; to: number; db: number; st: number }[];
}
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
  /** Keep the original audio low for the whole dub, not only while a line plays (default true). */
  holdDuck: boolean;
  /** Never cut the voice mid-sentence: lines wait for each other and catch up (≤ 2.5 s lag). Default true. */
  continuous: boolean;
  /** v1.1: use the free on-device neural voices (engine 'neural') once downloaded. Default true. */
  preferNeural: boolean;
  /** v1.1 (F): on-device Gemini Nano (Prompt API) shortens French lines that are too long for their slot. Default true. */
  smartFrench: boolean;
  /** v1.1 (F): when YouTube has an official / auto-dubbed audio track in the target language, switch to it instead of TTS. Default true. */
  preferOfficialAudio: boolean;
  /** v1.2 (E): expressive voice 0 (flat, v1.1 sound) .. 1 (lively). Default 0.7. */
  expressiveness: number;
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
  /** v1.1 (F): true while YouTube's own target-language audio track plays instead of the TTS dub. */
  usingOfficialAudio?: boolean;
  firstLineMs?: number;
  currentLineId?: string;
}

export interface Feedback { videoId: string; lineId: string; lang: Lang; up: boolean; rate: number; overflowMs: number; at: number }

export interface TtsRequest { text: string; lang: Lang; engine: 'openai' | 'elevenlabs'; voice: string; speed?: number }
export interface TtsResult { audioB64: string; mime: string }
/** v1.1 neural voices (Piper, on this computer). `voice` = neural voice id (see content/voice/neural-catalog.ts). */
export interface NeuralTtsRequest { text: string; lang: Lang; voice: string; /** v1.2 (E): expressive rendering; absent = v1.1 sound. */ prosody?: ProsodyParams }
/** `pending` = model still downloading (no audio; play Web Speech meanwhile). `ms` = exact duration at rate 1. */
export interface NeuralTtsResult { audioB64?: string; mime?: string; ms?: number; pending?: boolean; progress?: number; rtf?: number; threads?: number; /** v1.2 (E): post-processing time (ms). */ postMs?: number }
/** Download state of one neural model. `progress` 0..1. */
export interface NeuralModelState { model: string; ready: boolean; progress?: number; error?: string }

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
