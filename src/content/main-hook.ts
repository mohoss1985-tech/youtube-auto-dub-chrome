// MAIN-world entry (document_start). Owner: A.
// Hooks fetch/XHR to capture /api/timedtext URLs (posts AD_TIMEDTEXT_URL) and serves AD_REQ ops
// ('playerResponse' | 'json3' | 'audioTracks' | 'translate') with AD_RES over window.postMessage.
// Runs in the page world: no chrome.* APIs here.
import { BRIDGE_SOURCE, isBridgeMsg, type BridgeMsg } from '../shared/messages';
import type { CaptionTrack, Json3, PlayerResponse } from '../shared/types';
import { listAudioTracks, rewriteTimedtextUrl, timedtextVideoId } from './captions';
import { getTranslatorGlobal, runTranslator } from './translate-local';

type AnyPlayer = HTMLElement & {
  getPlayerResponse?: () => PlayerResponse | null;
  getOption?: (mod: string, key: string) => unknown;
  setOption?: (mod: string, key: string, val: unknown) => void;
  loadModule?: (mod: string) => void;
  unloadModule?: (mod: string) => void;
};

/** videoId → captured timedtext URLs (oldest first, ≤ 10). */
export const captured = new Map<string, string[]>();
let nativeFetch: typeof fetch = (...a) => fetch(...a);

function post(msg: BridgeMsg): void {
  try { window.postMessage(msg, location.origin === 'null' ? '*' : location.origin); } catch { /* ignore */ }
}

/** Remember a player-issued timedtext URL. Exported for tests. */
export function recordTimedtext(url: string): void {
  if (!url || !url.includes('/api/timedtext')) return;
  const abs = new URL(url, location.href).href;
  const v = timedtextVideoId(abs);
  if (!v) return;
  const list = captured.get(v) ?? [];
  if (list.includes(abs)) return;
  list.push(abs);
  if (list.length > 10) list.shift();
  captured.set(v, list);
  post({ source: BRIDGE_SOURCE, type: 'AD_TIMEDTEXT_URL', url: abs });
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return '';
}

// ---------------------------------------------------------------- json3 resolution (§3.4)

export interface Json3Args { track: CaptionTrack; videoId: string; tlang?: string | null }
export interface Json3Deps {
  fetch: typeof fetch;
  doc: Document;
  perfUrls: () => string[];
  sleep: (ms: number) => Promise<void>;
  captureWaitMs: number;
}

const defaultDeps = (): Json3Deps => ({
  fetch: nativeFetch,
  doc: document,
  perfUrls: () => {
    try { return performance.getEntriesByType('resource').map((e) => e.name); } catch { return []; }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  captureWaitMs: 3000,
});

class RateLimited extends Error { constructor() { super('RATE_LIMITED'); } }

async function tryFetch(deps: Json3Deps, url: string): Promise<Json3 | null> {
  let res: Response;
  try {
    res = await deps.fetch(url, { credentials: 'include' });
  } catch {
    return null;
  }
  if (res.status === 429) throw new RateLimited();
  if (!res.ok) return null;
  const txt = await res.text().catch(() => '');
  if (!txt.trim()) return null; // PO token needed → empty 200
  try {
    const j = JSON.parse(txt) as Json3;
    return j && Array.isArray(j.events) && j.events.length ? j : null;
  } catch {
    return null;
  }
}

function candidateUrls(deps: Json3Deps, track: CaptionTrack, videoId: string): string[] {
  const cap = (captured.get(videoId) ?? []).slice().reverse();
  // Prefer a capture already for this language.
  cap.sort((a, b) => Number(new URL(b).searchParams.get('lang') === track.languageCode) - Number(new URL(a).searchParams.get('lang') === track.languageCode));
  const perf = deps.perfUrls().filter((n) => timedtextVideoId(n) === videoId).reverse();
  const out = [...cap, ...perf];
  if (track.baseUrl && !/[?&]exp=xpe(&|$)/.test(track.baseUrl)) out.push(new URL(track.baseUrl, location.href).href);
  return [...new Set(out)];
}

const HIDE_ID = 'autodub-hide-cc';

/** Make the player request captions itself (it attaches a valid pot), capture that URL, restore the user's CC state. */
async function captureViaCC(deps: Json3Deps, track: CaptionTrack, videoId: string, tried: Set<string>): Promise<string[]> {
  const doc = deps.doc;
  const p = doc.getElementById('movie_player') as AnyPlayer | null;
  const btn = doc.querySelector<HTMLElement>('.ytp-subtitles-button');
  let style = doc.getElementById(HIDE_ID);
  if (!style) {
    style = doc.createElement('style');
    style.id = HIDE_ID;
    style.textContent = '.ytp-caption-window-container{display:none!important}';
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  let prev: { languageCode?: string } | null = null;
  try { prev = (p?.getOption?.('captions', 'track') as { languageCode?: string } | null) ?? null; } catch { /* ignore */ }
  const wasOn = !!prev?.languageCode || btn?.getAttribute('aria-pressed') === 'true';
  let clicked = false;
  try {
    if (p && typeof p.loadModule === 'function' && typeof p.setOption === 'function') {
      p.loadModule('captions');
      p.setOption('captions', 'track', track.kind ? { languageCode: track.languageCode, kind: track.kind } : { languageCode: track.languageCode });
    } else if (btn && !wasOn) {
      btn.click();
      clicked = true;
    }
    const found: string[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < deps.captureWaitMs) {
      await deps.sleep(150);
      for (const u of candidateUrls(deps, { ...track, baseUrl: '' }, videoId)) if (!tried.has(u) && !found.includes(u)) found.push(u);
      if (found.length) break;
    }
    return found;
  } finally {
    try {
      if (prev?.languageCode) p?.setOption?.('captions', 'track', prev);
      else if (!wasOn) {
        if (clicked) btn?.click();
        else p?.unloadModule?.('captions');
      }
    } catch { /* ignore */ }
    const s = style;
    setTimeout(() => s.remove(), wasOn ? 400 : 0);
  }
}

/** §3.4 order: captured URL → performance entry → baseUrl (no exp=xpe) → toggle CC and capture. Throws 'RATE_LIMITED' on 429. Exported for tests. */
export async function resolveJson3(args: Json3Args, deps: Json3Deps = defaultDeps()): Promise<Json3 | null> {
  const { track, videoId } = args;
  const tlang = args.tlang || null;
  const rewrite = (u: string) => rewriteTimedtextUrl(u, { lang: track.languageCode, kind: track.kind ?? null, tlang });
  const tried = new Set<string>();
  for (const c of candidateUrls(deps, track, videoId)) {
    tried.add(c);
    const j = await tryFetch(deps, rewrite(c));
    if (j) return j;
  }
  for (const c of await captureViaCC(deps, track, videoId, tried)) {
    const j = await tryFetch(deps, rewrite(c));
    if (j) return j;
  }
  return null;
}

// ---------------------------------------------------------------- player response

function slim(pr: PlayerResponse): PlayerResponse {
  const fmts = (pr.streamingData?.adaptiveFormats ?? []) as { audioTrack?: unknown }[];
  const out: PlayerResponse = {
    videoDetails: pr.videoDetails ? {
      videoId: pr.videoDetails.videoId, title: pr.videoDetails.title, lengthSeconds: pr.videoDetails.lengthSeconds, author: pr.videoDetails.author,
    } : undefined,
    captions: pr.captions,
    streamingData: { adaptiveFormats: fmts.filter((f) => f && f.audioTrack).map((f) => ({ audioTrack: f.audioTrack })) },
  };
  return JSON.parse(JSON.stringify(out)) as PlayerResponse;
}

/** movie_player.getPlayerResponse(), else ytInitialPlayerResponse — only when the videoId matches. Exported for tests. */
export function readPlayerResponse(videoId?: string | null): PlayerResponse | null {
  const matches = (pr: PlayerResponse | null | undefined): pr is PlayerResponse =>
    !!pr && typeof pr === 'object' && (!videoId || pr.videoDetails?.videoId === videoId);
  try {
    const p = document.getElementById('movie_player') as AnyPlayer | null;
    const pr = typeof p?.getPlayerResponse === 'function' ? p.getPlayerResponse() : null;
    if (matches(pr)) return slim(pr);
  } catch { /* ignore */ }
  const ipr = (window as unknown as { ytInitialPlayerResponse?: PlayerResponse }).ytInitialPlayerResponse;
  return matches(ipr) ? slim(ipr) : null;
}

// ---------------------------------------------------------------- AD_REQ server

async function serve(reqId: string, op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case 'playerResponse':
      return readPlayerResponse(args.videoId as string | undefined);
    case 'audioTracks':
      return listAudioTracks(readPlayerResponse(args.videoId as string | undefined));
    case 'json3':
      return resolveJson3(args as unknown as Json3Args);
    case 'translate': {
      const T = getTranslatorGlobal();
      if (!T) return null;
      const texts = Array.isArray(args.texts) ? (args.texts as unknown[]).map(String) : [];
      return runTranslator(
        T, texts, String(args.from ?? ''), String(args.to ?? ''),
        (loaded) => post({ source: BRIDGE_SOURCE, type: 'AD_PROGRESS', reqId, loaded }),
        (done, total) => post({ source: BRIDGE_SOURCE, type: 'AD_PROGRESS', reqId, done, total }),
      );
    }
    default:
      throw new Error('NETWORK');
  }
}

function onMessage(ev: MessageEvent): void {
  if (ev.source !== null && ev.source !== window) return;
  const d = ev.data as unknown;
  if (!isBridgeMsg(d) || d.type !== 'AD_REQ') return;
  const { reqId, op } = d;
  const args = (d.args && typeof d.args === 'object' ? d.args : {}) as Record<string, unknown>;
  serve(reqId, op, args).then(
    (data) => post({ source: BRIDGE_SOURCE, type: 'AD_RES', reqId, ok: true, data }),
    (e: unknown) => post({ source: BRIDGE_SOURCE, type: 'AD_RES', reqId, ok: false, error: e instanceof RateLimited ? 'RATE_LIMITED' : 'NETWORK' }),
  );
}

/** Install the fetch/XHR hooks and the AD_REQ responder once per page. */
export function installHook(): void {
  const w = window as unknown as { __autodubHook?: boolean };
  if (typeof window === 'undefined' || w.__autodubHook) return;
  w.__autodubHook = true;

  if (typeof window.fetch === 'function') {
    const of = window.fetch;
    nativeFetch = of.bind(window);
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      try { recordTimedtext(urlOf(input)); } catch { /* never break the page */ }
      return of.call(this ?? window, input, init);
    } as typeof fetch;
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      try { recordTimedtext(urlOf(url)); } catch { /* ignore */ }
      return (oo as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof oo;
  }
  window.addEventListener('message', onMessage);
}

installHook();
