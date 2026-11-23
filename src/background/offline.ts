// v1.2.1 (T): OFFLINE_TRANSLATE, service-worker side. Routes ≤ 16 lines to the offscreen document, which tries
// Chrome's Translator API (extension context) and else Opus-MT (mt-worker.js). Never rejects.
import type { MsgOf, MsgResponse, OfflineTranslateResult } from '../shared/messages';
import { OFFLINE_BATCH } from '../shared/offline-mt';
import { OFFSCREEN_TARGET, type MtReq, type MtRes } from '../offscreen/protocol';
import { ensureOffscreen } from './neural';

/** One batch of ≤ 16 sentences takes ~1–6 s on CPU; the first call after a download also loads the model (~2–5 s). */
export const OFFLINE_TIMEOUT_MS = 60_000;

export async function callOffscreenMt(req: MtReq, timeoutMs = OFFLINE_TIMEOUT_MS): Promise<MtRes> {
  try {
    await ensureOffscreen();
    const res = await Promise.race([
      chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, req }) as Promise<MtRes | undefined>,
      new Promise<MtRes>((r) => setTimeout(() => r({ ok: false, code: 'ENGINE_ERROR', message: 'Offline translator timed out' }), timeoutMs)),
    ]);
    return res ?? { ok: false, code: 'ENGINE_ERROR', message: 'No answer from the offline translator' };
  } catch (e) {
    return { ok: false, code: 'ENGINE_ERROR', message: e instanceof Error ? e.message : String(e) };
  }
}

export async function onOfflineTranslate(msg: MsgOf<'OFFLINE_TRANSLATE'>): Promise<MsgResponse<OfflineTranslateResult>> {
  const out: string[] = [];
  let engine: OfflineTranslateResult['engine'];
  let computeMs = 0;
  for (let i = 0; i < msg.texts.length || i === 0; i += OFFLINE_BATCH) {
    const part = msg.texts.slice(i, i + OFFLINE_BATCH);
    if (!part.length) break;
    const r = await callOffscreenMt({ op: 'mt', texts: part, from: msg.from, to: msg.to });
    if (!r.ok) return { ok: false, error: r.code === 'NO_TRANSLATION' ? 'NO_TRANSLATION' : 'ENGINE_ERROR', message: r.message };
    if (r.pending) {
      const p: OfflineTranslateResult = { pending: true, progress: r.progress ?? 0 };
      if (r.sizeMB != null) p.sizeMB = r.sizeMB;
      return { ok: true, ...p };
    }
    if (!r.texts || r.texts.length !== part.length) return { ok: false, error: 'NO_TRANSLATION', message: 'Offline translation returned a different line count.' };
    out.push(...r.texts);
    engine = r.engine;
    computeMs += r.computeMs ?? 0;
  }
  return { ok: true, texts: out, engine, computeMs };
}
