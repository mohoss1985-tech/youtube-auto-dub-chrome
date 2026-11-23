// AutoDub runtime + window-bridge messages (DESIGN_SPEC §8). Owner: A.
import type { CacheStore, DubStatus, EngineId, ErrorCode, Lang, TtsRequest, TtsResult, VoiceInfo } from './types';
import { DubError } from './types';

// ---------------- Runtime messages (chrome.runtime / chrome.tabs) ----------------

export type Msg =
  | { type: 'TRANSLATE'; texts: string[]; from: string; to: Lang }
  | ({ type: 'TTS' } & TtsRequest)
  | { type: 'CACHE_GET'; store: Extract<CacheStore, 'lines'>; key: string }
  | { type: 'CACHE_PUT'; store: Extract<CacheStore, 'lines'>; key: string; value: unknown }
  | { type: 'DUB_TOGGLE'; on?: boolean }
  | { type: 'GET_STATUS' }
  | { type: 'STATUS'; status: DubStatus }
  | { type: 'LIST_VOICES'; lang: Lang }
  | { type: 'TEST_VOICE'; lang: Lang; engine: EngineId; voice: string };

export type MsgType = Msg['type'];
export type MsgOf<T extends MsgType> = Extract<Msg, { type: T }>;

/** Success payload per message type (merged with `{ok:true}`). */
export interface MsgResultMap {
  TRANSLATE: { texts: string[] };
  TTS: TtsResult;
  CACHE_GET: { value?: unknown };
  CACHE_PUT: {};
  DUB_TOGGLE: { status: DubStatus };
  GET_STATUS: { status: DubStatus };
  STATUS: {};
  LIST_VOICES: { voices: VoiceInfo[] };
  TEST_VOICE: {};
}

export interface MsgError { ok: false; error: ErrorCode; message?: string }
export type MsgResponse<T = {}> = ({ ok: true } & T) | MsgError;
export type ResponseOf<T extends MsgType> = MsgResponse<MsgResultMap[T]>;

/** Messages handled by the service worker. */
export const SW_MSG_TYPES = ['TRANSLATE', 'TTS', 'CACHE_GET', 'CACHE_PUT'] as const;
export type SWMsg = MsgOf<(typeof SW_MSG_TYPES)[number]>;

export function isMsg(x: unknown): x is Msg {
  return !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string';
}
export function isSWMsg(x: unknown): x is SWMsg {
  return isMsg(x) && (SW_MSG_TYPES as readonly string[]).includes(x.type);
}

/** Build a `{ok:false}` response from anything thrown (DubError keeps its code; others → NETWORK). */
export function toMsgError(e: unknown, fallback: ErrorCode = 'NETWORK'): MsgError {
  if (e instanceof DubError) return { ok: false, error: e.code, message: e.message };
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError') return { ok: false, error: 'TIMEOUT', message: 'Request timed out' };
  return { ok: false, error: fallback, message: e instanceof Error ? e.message : String(e) };
}

const DEFAULT_TIMEOUT_MS = 25_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | MsgError> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'TIMEOUT', message: `No response in ${ms} ms` }), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); resolve(toMsgError(e)); },
    );
  });
}

function normalize<T>(res: unknown): MsgResponse<T> {
  if (res && typeof res === 'object' && 'ok' in res) return res as MsgResponse<T>;
  const err = chrome.runtime?.lastError?.message;
  return { ok: false, error: 'NETWORK', message: err ?? 'No response' };
}

/** Send a message to the service worker. Never rejects: failures become `{ok:false}`. */
export async function sendToSW<M extends Msg>(msg: M, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ResponseOf<M['type']>> {
  const res = await withTimeout(Promise.resolve(chrome.runtime.sendMessage(msg)), timeoutMs);
  return normalize<MsgResultMap[M['type']]>(res);
}

/** Send a message to the content script of a tab. Never rejects: failures become `{ok:false}`. */
export async function sendToTab<M extends Msg>(tabId: number, msg: M, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ResponseOf<M['type']>> {
  const res = await withTimeout(Promise.resolve(chrome.tabs.sendMessage(tabId, msg)), timeoutMs);
  return normalize<MsgResultMap[M['type']]>(res);
}

/** Fire-and-forget STATUS broadcast from a tab (popup may be closed; errors swallowed). */
export function broadcastStatus(status: DubStatus): void {
  try {
    Promise.resolve(chrome.runtime.sendMessage({ type: 'STATUS', status } satisfies Msg)).catch(() => {});
  } catch {
    /* extension context invalidated */
  }
}

// ---------------- Window bridge (MAIN ⇄ ISOLATED) ----------------

export const BRIDGE_SOURCE = 'autodub' as const;

/** Bridge ops served by main-hook.ts. 'translate' = Translator API fallback in MAIN world (§3.5). */
export type BridgeOp = 'playerResponse' | 'json3' | 'audioTracks' | 'translate';

export type BridgeMsg =
  | { source: typeof BRIDGE_SOURCE; type: 'AD_TIMEDTEXT_URL'; url: string }
  | { source: typeof BRIDGE_SOURCE; type: 'AD_REQ'; reqId: string; op: BridgeOp; args?: unknown }
  | { source: typeof BRIDGE_SOURCE; type: 'AD_RES'; reqId: string; ok: boolean; data?: unknown; error?: string }
  /** Progress for a long op (translate): `loaded` = model download 0..1, or `done/total` lines translated. */
  | { source: typeof BRIDGE_SOURCE; type: 'AD_PROGRESS'; reqId: string; loaded?: number; done?: number; total?: number };

export function isBridgeMsg(x: unknown): x is BridgeMsg {
  return !!x && typeof x === 'object' && (x as { source?: unknown }).source === BRIDGE_SOURCE && typeof (x as { type?: unknown }).type === 'string';
}
