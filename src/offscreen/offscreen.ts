// Offscreen document (reason WORKERS): hosts the Piper neural-voice Worker. Owner: P (v1.1).
// Only chrome.runtime exists here. Relays SW requests to the worker and worker events back to the SW.
// v1.2.1 (T): also hosts free offline translation (op 'mt'): Chrome's Translator API when this extension context
// has it (it can exist here even when youtube.com lacks it), else Opus-MT in mt-worker.js.
import { SW_TARGET, isOffscreenMsg, type MtReq, type MtRes, type WorkerEvent, type WorkerReq, type WorkerRes } from './protocol';
import { getTranslatorGlobal, runTranslator, apiLang } from '../content/translate-local';

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (res: WorkerRes) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(chrome.runtime.getURL('piper-worker.js'), { type: 'module', name: 'autodub-piper' });
  w.onmessage = (ev: MessageEvent<{ id?: number; res?: WorkerRes } & Partial<WorkerEvent>>) => {
    const d = ev.data;
    if (typeof d.id === 'number' && d.res) {
      waiting.get(d.id)?.(d.res);
      waiting.delete(d.id);
      return;
    }
    if (d.event) {
      try { void Promise.resolve(chrome.runtime.sendMessage({ target: SW_TARGET, ev: d as WorkerEvent })).catch(() => {}); } catch { /* SW asleep */ }
    }
  };
  w.onerror = (e) => {
    // A crashed worker fails every pending call; the next call starts a fresh one.
    for (const [id, cb] of waiting) { cb({ ok: false, code: 'ENGINE_ERROR', message: e.message || 'Neural voice worker crashed' }); waiting.delete(id); }
    worker = null;
  };
  worker = w;
  return w;
}

export function call(req: WorkerReq): Promise<WorkerRes> {
  return new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    getWorker().postMessage({ id, req });
  });
}

// ---------------------------------------------------------------- v1.2.1 offline translation

let mtWorker: Worker | null = null;
const mtWaiting = new Map<number, (res: MtRes) => void>();

function getMtWorker(): Worker {
  if (mtWorker) return mtWorker;
  const w = new Worker(chrome.runtime.getURL('mt-worker.js'), { type: 'module', name: 'autodub-mt' });
  w.onmessage = (ev: MessageEvent<{ id?: number; res?: MtRes }>) => {
    const d = ev.data;
    if (typeof d.id === 'number' && d.res) { mtWaiting.get(d.id)?.(d.res); mtWaiting.delete(d.id); }
  };
  w.onerror = (e) => {
    for (const [id, cb] of mtWaiting) { cb({ ok: false, code: 'ENGINE_ERROR', message: e.message || 'Offline translator crashed' }); mtWaiting.delete(id); }
    mtWorker = null;
  };
  mtWorker = w;
  return w;
}

function callMt(req: MtReq): Promise<MtRes> {
  return new Promise((resolve) => {
    const id = ++seq;
    mtWaiting.set(id, resolve);
    getMtWorker().postMessage({ id, req });
  });
}

/** Pairs the extension-context Translator API refused (no retry this session: it does not change while Chrome runs). */
const chromeNo = new Set<string>();

/** Chrome's Translator API in this (extension) context, only when the model is already on the device (no user activation here). */
async function chromeTranslate(req: MtReq): Promise<string[] | null> {
  const T = getTranslatorGlobal();
  if (!T) return null;
  const k = `${apiLang(req.from)}-${apiLang(req.to)}`;
  if (chromeNo.has(k)) return null;
  try {
    const a = await T.availability({ sourceLanguage: apiLang(req.from), targetLanguage: apiLang(req.to) });
    if (a !== 'available' && a !== 'readily') { chromeNo.add(k); return null; }
  } catch { chromeNo.add(k); return null; }
  const out = await runTranslator(T, req.texts, req.from, req.to);
  if (!out) chromeNo.add(k);
  return out;
}

export async function translateOffline(req: MtReq): Promise<MtRes> {
  const t0 = performance.now();
  const c = await chromeTranslate(req).catch(() => null);
  if (c && c.length === req.texts.length) return { ok: true, texts: c, engine: 'chrome', computeMs: performance.now() - t0 };
  return callMt(req);
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isOffscreenMsg(msg)) return false;
  if (msg.req.op === 'mt') translateOffline(msg.req).then(sendResponse);
  else call(msg.req).then(sendResponse);
  return true;
});

// Test hooks (Playwright measures RTF / translation speed through the extension page).
(globalThis as unknown as { autodubNeural?: typeof call }).autodubNeural = call;
(globalThis as unknown as { autodubOffline?: typeof translateOffline }).autodubOffline = translateOffline;
