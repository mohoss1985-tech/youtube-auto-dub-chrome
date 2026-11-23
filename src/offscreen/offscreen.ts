// Offscreen document (reason WORKERS): hosts the Piper neural-voice Worker. Owner: P (v1.1).
// Only chrome.runtime exists here. Relays SW requests to the worker and worker events back to the SW.
import { SW_TARGET, isOffscreenMsg, type WorkerEvent, type WorkerReq, type WorkerRes } from './protocol';

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

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isOffscreenMsg(msg)) return false;
  call(msg.req).then(sendResponse);
  return true;
});

// Test hook (Playwright measures RTF through the extension page).
(globalThis as unknown as { autodubNeural?: typeof call }).autodubNeural = call;
