// Captions → translated, merged Line[] for one video+language (§3). Owner: A.
// Order: cache → player response → pickTrack → json3 → merge sentences → translate (if needed) → cache.
// Translation chain (merge BEFORE translating):
//   human track: YouTube tlang → Chrome Translator API (on-device) → OpenAI (SW, user key)
//   ASR track:   Translator API → tlang → OpenAI   (tlang of ASR fragments gives poor sentences)
import { sendToSW } from '../shared/messages';
import { LANG_INFO } from '../shared/settings';
import { DubError, type CaptionTrack, type ErrorCode, type Lang, type Line } from '../shared/types';
import { isAsrTrack, langBase, mergeSentences, parseJson3, pickTrack } from './captions';
import { translateLocal } from './translate-local';
import { getJson3, getPlayerResponse } from './yt';

export interface GetLinesOptions {
  /** Media time (s) to translate first (e.g. video.currentTime). Default 0. */
  fromTime?: number;
  /**
   * Progressive mode for slow translators (on-device / OpenAI): getLines resolves as soon as the first
   * chunk (≈ 40 lines from `fromTime`) is translated, then calls `onUpdate` with the full, sorted list of
   * translated lines after each further chunk (last call = complete). Without it, getLines waits for all.
   */
  onUpdate?: (lines: Line[]) => void;
}

export const FIRST_CHUNK = 40;
export const LOCAL_CHUNK = 100;
export const SW_CHUNK = 40;

/** One tlang try per video+lang per page session (§3.5; YouTube 429s auto-translated tracks). */
const tlangTried = new Set<string>();

/** For tests. */
export function _resetPipeline(): void {
  tlangTried.clear();
}

export const cacheKey = (videoId: string, lang: Lang) => `lines:${videoId}:${lang}`;

function validLines(v: unknown): v is Line[] {
  return Array.isArray(v) && v.length > 0 && v.every((l) => l && typeof l.text === 'string' && typeof l.start === 'number' && typeof l.id === 'string');
}

async function cachePut(videoId: string, lang: Lang, lines: Line[]): Promise<void> {
  try { await sendToSW({ type: 'CACHE_PUT', store: 'lines', key: cacheKey(videoId, lang), value: lines }); } catch { /* best effort */ }
}

/** Chunks in priority order: from the line at `fromTime` forward, then the earlier part. */
export function planChunks(lines: Line[], fromTime: number, first: number, size: number): [number, number][] {
  const n = lines.length;
  let idx = lines.findIndex((l) => l.end >= fromTime);
  if (idx < 0) idx = 0;
  const out: [number, number][] = [];
  let a = idx;
  let b = Math.min(n, a + first);
  out.push([a, b]);
  for (a = b; a < n; a = b) { b = Math.min(n, a + size); out.push([a, b]); }
  for (a = 0; a < idx; a = b) { b = Math.min(idx, a + size); out.push([a, b]); }
  return out.filter(([x, y]) => y > x);
}

type Tx = (texts: string[]) => Promise<string[] | null>;
interface TxResult { lines: Line[]; complete: boolean }

/** Translate `src` with `tx` in chunks. null if the first chunk fails (caller tries the next translator). */
async function runChunks(src: Line[], tx: Tx, chunkSize: number, opts: GetLinesOptions | undefined, onDone: (lines: Line[]) => void): Promise<TxResult | null> {
  const chunks = planChunks(src, opts?.fromTime ?? 0, FIRST_CHUNK, chunkSize);
  const done = new Map<number, Line>();
  const doChunk = async ([a, b]: [number, number]): Promise<boolean> => {
    const part = src.slice(a, b);
    const res = await tx(part.map((l) => l.text));
    if (!res || res.length !== part.length) return false;
    part.forEach((l, i) => done.set(a + i, { ...l, text: (res[i] ?? '').trim(), source: l.text }));
    return true;
  };
  const collect = (): Line[] => [...done.keys()].sort((x, y) => x - y).map((i) => done.get(i)!).filter((l) => l.text);

  if (!chunks.length || !(await doChunk(chunks[0]!))) return null;
  const rest = chunks.slice(1);
  if (!opts?.onUpdate || !rest.length) {
    for (const c of rest) if (!(await doChunk(c))) return null;
    return { lines: collect(), complete: true };
  }
  const onUpdate = opts.onUpdate;
  void (async () => {
    for (const c of rest) {
      let ok = false;
      try { ok = await doChunk(c); } catch { ok = false; }
      if (!ok) return; // keep what we have; not cached
      onUpdate(collect());
    }
    onDone(collect());
  })();
  return { lines: collect(), complete: false };
}

/** Full pipeline with SW cache `lines:<videoId>:<lang>`. Throws DubError NO_CAPTIONS | NO_TRANSLATION | RATE_LIMITED. `onProgress` gets user-facing status text (e.g. "Downloading French translator…"). */
export async function getLines(videoId: string, lang: Lang, onProgress?: (message: string) => void, opts?: GetLinesOptions): Promise<Line[]> {
  const say = (m: string) => { try { onProgress?.(m); } catch { /* ignore */ } };
  const langName = LANG_INFO[lang]?.name ?? lang;

  const hit = await sendToSW({ type: 'CACHE_GET', store: 'lines', key: cacheKey(videoId, lang) });
  if (hit.ok && validLines(hit.value)) return hit.value;

  say('Loading captions…');
  const pr = await getPlayerResponse(videoId);
  const renderer = pr?.captions?.playerCaptionsTracklistRenderer;
  const tracks = (renderer?.captionTracks ?? []) as (CaptionTrack & { isTranslatable?: boolean })[];
  const track = pickTrack(tracks, lang) as (CaptionTrack & { isTranslatable?: boolean }) | null;
  if (!track) throw new DubError('NO_CAPTIONS', 'This video has no captions, so it cannot be dubbed.');

  const loadOriginal = async (): Promise<Line[]> => {
    const json = await getJson3(track, videoId);
    const lines = json ? mergeSentences(parseJson3(json), track.languageCode) : [];
    if (!lines.length) throw new DubError('NO_CAPTIONS', 'YouTube did not return the captions for this video. Try reloading the page.');
    return lines;
  };

  // Track already in the target language → no translation.
  if (langBase(track.languageCode) === lang) {
    const lines = await loadOriginal();
    await cachePut(videoId, lang, lines);
    return lines;
  }

  const tl = renderer?.translationLanguages;
  const canTlang = track.isTranslatable !== false && (!tl?.length || tl.some((l) => langBase(l.languageCode) === lang));
  const tryTlang = async (): Promise<Line[] | null> => {
    const k = `${videoId}:${lang}`;
    if (!canTlang || tlangTried.has(k)) return null;
    tlangTried.add(k);
    say(`Getting ${langName} captions from YouTube…`);
    try {
      const json = await getJson3(track, videoId, lang);
      const lines = json ? mergeSentences(parseJson3(json), lang) : [];
      return lines.length ? lines : null;
    } catch {
      return null; // RATE_LIMITED (429) or bridge failure → our own translation
    }
  };

  const finish = async (lines: Line[]): Promise<Line[]> => {
    await cachePut(videoId, lang, lines);
    return lines;
  };
  const asr = isAsrTrack(track);

  if (!asr) {
    const t = await tryTlang();
    if (t) return finish(t);
  }

  const src = await loadOriginal();
  const onDone = (all: Line[]) => void cachePut(videoId, lang, all);
  const use = async (r: TxResult): Promise<Line[]> => (r.complete ? finish(r.lines) : r.lines);

  // On-device Chrome Translator (free).
  const local: Tx = (texts) =>
    translateLocal(texts, track.languageCode, lang, (p) => say(`Downloading ${langName} translator… ${Math.round(p * 100)}%`));
  say(`Translating to ${langName}…`);
  const lr = await runChunks(src, local, LOCAL_CHUNK, opts, onDone);
  if (lr) return use(lr);

  if (asr) {
    const t = await tryTlang();
    if (t) return finish(t);
  }

  // OpenAI via the service worker (user key).
  let swErr: { error: ErrorCode; message?: string } | null = null;
  const sw: Tx = async (texts) => {
    const r = await sendToSW({ type: 'TRANSLATE', texts, from: track.languageCode, to: lang });
    if (r.ok) return r.texts;
    swErr = { error: r.error, message: r.message };
    return null;
  };
  say(`Translating to ${langName} with OpenAI…`);
  const sr = await runChunks(src, sw, SW_CHUNK, opts, onDone);
  if (sr) return use(sr);

  const err = swErr as { error: ErrorCode; message?: string } | null;
  if (err?.error === 'RATE_LIMITED') throw new DubError('RATE_LIMITED', err.message ?? 'Translation rate limit reached. Try again in a minute.');
  const from = LANG_INFO[langBase(track.languageCode) as Lang]?.name ?? track.languageCode;
  const why =
    err?.error === 'NO_KEY'
      ? `No free ${from} → ${langName} translator is available on this device, and no OpenAI key is set. Add an OpenAI key in AutoDub settings (Engine), or update Chrome.`
      : `Could not translate this video to ${langName}${err?.message ? ` (${err.message})` : ''}.`;
  throw new DubError('NO_TRANSLATION', why);
}
