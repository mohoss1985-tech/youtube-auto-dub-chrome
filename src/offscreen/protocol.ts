// Internal protocol: service worker ⇄ offscreen document ⇄ piper worker. Owner: P (v1.1).
import type { ProsodyParams } from '../shared/types';
// Not part of the public Msg union (content/popup use NEURAL_TTS / NEURAL_STATUS via the service worker).

export const OFFSCREEN_TARGET = 'autodub-offscreen' as const;
export const SW_TARGET = 'autodub-sw' as const;

export interface DownloadProgress { model: string; loaded: number; total: number; done?: boolean; error?: string }

export type WorkerReq =
  | { op: 'tts'; text: string; voice: string; lengthScale?: number; /** v1.2 (E): expressive rendering; absent = v1.1. */ prosody?: ProsodyParams }
  | { op: 'download'; models: string[] }
  | { op: 'remove'; models: string[] }
  | { op: 'status'; models?: string[] }
  | { op: 'warmup' };

export type WorkerRes =
  | {
    ok: true;
    /** tts: model still downloading → no audio (caller uses Web Speech meanwhile). */
    pending?: boolean;
    progress?: number | DownloadProgress[];
    audioB64?: string;
    mime?: string;
    /** Exact audio duration (ms) at rate 1. */
    ms?: number;
    computeMs?: number;
    /** v1.2 (E): of which expressive post-processing (ms). */
    postMs?: number;
    /** Real-time factor = compute time / audio time. */
    rtf?: number;
    /** WASM threads used (1 unless crossOriginIsolated). */
    threads?: number;
    ready?: string[];
  }
  | { ok: false; code: 'NO_VOICE' | 'ENGINE_ERROR'; message?: string };

export type WorkerEvent =
  | { event: 'progress'; progress: DownloadProgress }
  | { event: 'downloaded'; model: string }
  | { event: 'error'; model: string; message: string };

/** SW → offscreen document. */
export interface OffscreenMsg { target: typeof OFFSCREEN_TARGET; req: WorkerReq }
/** Offscreen document → SW (download finished/failed). */
export interface OffscreenEventMsg { target: typeof SW_TARGET; ev: WorkerEvent }

export function isOffscreenMsg(x: unknown): x is OffscreenMsg {
  return !!x && typeof x === 'object' && (x as { target?: unknown }).target === OFFSCREEN_TARGET;
}
export function isOffscreenEventMsg(x: unknown): x is OffscreenEventMsg {
  return !!x && typeof x === 'object' && (x as { target?: unknown }).target === SW_TARGET;
}
