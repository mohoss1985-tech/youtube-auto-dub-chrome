// YouTube bridge for the isolated content script. Owner: A.
// All YouTube internals go through here (+ main-hook.ts in the MAIN world), so breakage is fixed in one place.
// No chrome.* here: main-hook.ts bundles this module indirectly (via translate-local.ts).
import { BRIDGE_SOURCE, isBridgeMsg, type BridgeMsg, type BridgeOp } from '../shared/messages';
import { DubError, type AudioTrackInfo, type CaptionTrack, type Json3, type PlayerResponse } from '../shared/types';

// ---------------------------------------------------------------- page / DOM

/** Video id from a URL (default location.href) for /watch?v=; null otherwise. */
export function getVideoId(url?: string): string | null {
  let u: URL;
  try {
    u = new URL(url ?? location.href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^(www\.)?youtube\.com$/.test(u.hostname)) return null;
  if (u.pathname !== '/watch') return null;
  const v = u.searchParams.get('v');
  return v && /^[\w-]{6,20}$/.test(v) ? v : null;
}

/** True for https://www.youtube.com/watch?v=… (never /shorts/). */
export function isWatchPage(url?: string): boolean {
  return getVideoId(url) !== null;
}

/** The #movie_player element, or null. */
export function getPlayer(): HTMLElement | null {
  return document.getElementById('movie_player');
}

/** The main <video> element of the player, or null. */
export function getVideo(): HTMLVideoElement | null {
  const p = getPlayer();
  return (
    p?.querySelector<HTMLVideoElement>('video.html5-main-video') ??
    p?.querySelector<HTMLVideoElement>('video') ??
    document.querySelector<HTMLVideoElement>('video.html5-main-video')
  );
}

// ---------------------------------------------------------------- bridge client

export interface BridgeProgress { loaded?: number; done?: number; total?: number }
export interface BridgeRequestOptions {
  /** Idle timeout; reset by every AD_PROGRESS for this request. */
  timeoutMs?: number;
  onProgress?: (p: BridgeProgress) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: (p: BridgeProgress) => void;
  timer: ReturnType<typeof setTimeout>;
  arm: () => void;
}

const pending = new Map<string, Pending>();
let listening = false;
let seq = 0;
const prefix = Math.random().toString(36).slice(2, 8);

function ensureListener(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== null && ev.source !== window) return;
    const d = ev.data as unknown;
    if (!isBridgeMsg(d)) return;
    if (d.type !== 'AD_RES' && d.type !== 'AD_PROGRESS') return;
    const p = pending.get(d.reqId);
    if (!p) return;
    if (d.type === 'AD_PROGRESS') {
      p.arm();
      try { p.onProgress?.({ loaded: d.loaded, done: d.done, total: d.total }); } catch { /* ignore */ }
      return;
    }
    clearTimeout(p.timer);
    pending.delete(d.reqId);
    if (d.ok) p.resolve(d.data);
    else p.reject(new DubError(isCode(d.error) ? d.error : 'NETWORK', d.error ?? 'Bridge error'));
  });
}

const CODES = new Set(['NO_CAPTIONS', 'NO_TRANSLATION', 'RATE_LIMITED', 'ENGINE_ERROR', 'NO_VOICE', 'NOT_WATCH_PAGE', 'NETWORK', 'NO_KEY', 'TIMEOUT']);
const isCode = (s: unknown): s is DubError['code'] => typeof s === 'string' && CODES.has(s);

/** Send one AD_REQ to the MAIN-world hook and wait for its AD_RES. Rejects with DubError (TIMEOUT, RATE_LIMITED, …). */
export function bridgeRequest<T>(op: BridgeOp, args?: unknown, opts: BridgeRequestOptions = {}): Promise<T> {
  ensureListener();
  const reqId = `${prefix}-${++seq}`;
  const ms = opts.timeoutMs ?? 5000;
  return new Promise<T>((resolve, reject) => {
    const p: Pending = {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: opts.onProgress,
      timer: setTimeout(() => {}, 0),
      arm: () => {
        clearTimeout(p.timer);
        p.timer = setTimeout(() => {
          pending.delete(reqId);
          reject(new DubError('TIMEOUT', `YouTube bridge '${op}' did not answer`));
        }, ms);
      },
    };
    p.arm();
    pending.set(reqId, p);
    const msg: BridgeMsg = { source: BRIDGE_SOURCE, type: 'AD_REQ', reqId, op, args };
    window.postMessage(msg, location.origin === 'null' ? '*' : location.origin);
  });
}

// ---------------------------------------------------------------- ops

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Current player response via the MAIN-world bridge (movie_player.getPlayerResponse, fallback ytInitialPlayerResponse when videoId matches); null if unavailable. `videoId` (default: from the URL) must match — retried ~2 s after SPA navigation. */
export async function getPlayerResponse(videoId?: string): Promise<PlayerResponse | null> {
  const v = videoId ?? getVideoId() ?? undefined;
  for (let i = 0; i < 6; i++) {
    try {
      const pr = await bridgeRequest<PlayerResponse | null>('playerResponse', { videoId: v }, { timeoutMs: 3000 });
      if (pr) return pr;
    } catch {
      /* hook missing or slow */
    }
    await sleep(400);
  }
  return null;
}

/** Fetch json3 for a track in the MAIN world (captured URL → performance entry → baseUrl → CC toggle); sets/removes `tlang`. null on empty body; throws DubError('RATE_LIMITED') on 429. */
export async function getJson3(track: CaptionTrack, videoId: string, tlang?: string): Promise<Json3 | null> {
  try {
    const t: CaptionTrack = { baseUrl: track.baseUrl, languageCode: track.languageCode, vssId: track.vssId };
    if (track.kind) t.kind = track.kind;
    const j = await bridgeRequest<Json3 | null>('json3', { track: t, videoId, tlang: tlang ?? null }, { timeoutMs: 20_000 });
    return j && Array.isArray(j.events) ? j : null;
  } catch (e) {
    if (e instanceof DubError && e.code === 'RATE_LIMITED') throw e;
    return null;
  }
}

/** YouTube's official / auto-dubbed audio tracks for the current video (via the bridge); [] if none. */
export async function getAudioTracks(videoId?: string): Promise<AudioTrackInfo[]> {
  try {
    const v = videoId ?? getVideoId() ?? undefined;
    return (await bridgeRequest<AudioTrackInfo[]>('audioTracks', { videoId: v }, { timeoutMs: 3000 })) ?? [];
  } catch {
    return [];
  }
}
