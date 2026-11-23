// Chrome built-in Translator API (Chrome 138+, on-device, free). Owner: A.
// Docs: https://developer.chrome.com/docs/ai/translator-api — feature-detect with `'Translator' in self`.
// Not documented whether the global is exposed in an extension's ISOLATED world, so: use it here when present,
// else ask the MAIN-world hook (bridge op 'translate'), which runs the same runTranslator().
// Note: create() for a 'downloadable' model needs transient user activation (the Dub click) — call early.
import type { Lang } from '../shared/types';
import { bridgeRequest } from './yt';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available' | string;

interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy?(): void;
}
interface CreateMonitor { addEventListener(type: 'downloadprogress', cb: (e: { loaded?: number }) => void): void }
export interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: CreateMonitor) => void }): Promise<TranslatorInstance>;
}

/** BCP-47 the Translator API understands: base language, except Chinese script variants. */
export function apiLang(code: string): string {
  const c = code.trim();
  if (/^zh[-_](hant|tw|hk|mo)/i.test(c)) return 'zh-Hant';
  if (/^zh/i.test(c)) return 'zh';
  return c.toLowerCase().split(/[-_]/)[0] ?? c;
}

/** The global Translator in this JS world, or null. */
export function getTranslatorGlobal(): TranslatorStatic | null {
  const T = (globalThis as { Translator?: TranslatorStatic }).Translator;
  return T && typeof T.availability === 'function' && typeof T.create === 'function' ? T : null;
}

/**
 * Run the Translator API in the current world. null when unavailable, when create() is refused
 * (e.g. no user activation for a download) or when any line fails.
 */
export async function runTranslator(
  T: TranslatorStatic,
  texts: string[],
  from: string,
  to: string,
  onProgress?: (loaded: number) => void,
  onTranslated?: (done: number, total: number) => void,
): Promise<string[] | null> {
  const opts = { sourceLanguage: apiLang(from), targetLanguage: apiLang(to) };
  if (opts.sourceLanguage === opts.targetLanguage) return texts.slice();
  let avail: Availability;
  try {
    avail = await T.availability(opts);
  } catch {
    return null;
  }
  if (avail === 'unavailable' || avail === 'no') return null;
  const needsDownload = avail === 'downloadable' || avail === 'downloading' || avail === 'after-download';
  if (needsDownload) onProgress?.(0);
  let tr: TranslatorInstance;
  try {
    tr = await T.create({
      ...opts,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const v = Number(e?.loaded);
          if (Number.isFinite(v)) onProgress?.(Math.max(0, Math.min(1, v)));
        });
      },
    });
  } catch {
    return null;
  }
  if (needsDownload) onProgress?.(1);
  try {
    const out: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i] ?? '';
      out.push(t.trim() ? String(await tr.translate(t)) : t);
      if (onTranslated && ((i + 1) % 10 === 0 || i + 1 === texts.length)) onTranslated(i + 1, texts.length);
    }
    return out;
  } catch {
    return null;
  } finally {
    try { tr.destroy?.(); } catch { /* ignore */ }
  }
}

/** Translate with the on-device Translator API, keeping line count. Returns null when the API or language pair is unavailable. `onProgress` gets model download progress 0..1; `onTranslated` gets lines done. */
export async function translateLocal(
  texts: string[],
  from: string,
  to: Lang,
  onProgress?: (loaded: number) => void,
  onTranslated?: (done: number, total: number) => void,
): Promise<string[] | null> {
  if (!texts.length) return [];
  const T = getTranslatorGlobal();
  if (T) return runTranslator(T, texts, from, to, onProgress, onTranslated);
  // ISOLATED world without the global → run it in the page (MAIN) world.
  try {
    const res = await bridgeRequest<string[] | null>('translate', { texts, from, to }, {
      timeoutMs: 30_000,
      onProgress: (p) => {
        if (typeof p.loaded === 'number') onProgress?.(p.loaded);
        if (typeof p.done === 'number' && typeof p.total === 'number') onTranslated?.(p.done, p.total);
      },
    });
    return Array.isArray(res) && res.length === texts.length ? res.map(String) : null;
  } catch {
    return null;
  }
}
